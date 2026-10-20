//! Live video inputs, shown by the Video widget.
//!
//! - Streams (SRT, UDP, RTMP, HLS, RTSP, any address ffmpeg reads) are
//!   decoded by ffmpeg into raw pictures; SRT and RTMP can also wait for the
//!   sender to connect (listener).
//! - NDI sources are received through the NDI runtime (the one the NDI
//!   outputs use).
//! - SDI inputs need DeckLink support, which this server is built without.
//!
//! Pictures off a network come unevenly (bursts, gaps). Each one is given a
//! time to be shown, `buffer` frames after it came and at least one frame
//! after the previous one: the renderers, drawing at their own pace, get an
//! even motion back, at the cost of that much delay. The previews
//! (`/api/inputs/<id>/live.mjpeg`) send the newest picture as JPEG.
//! Inputs keep running across engine restarts; saving the settings only
//! restarts the ones that changed.

use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tiny_skia::{IntSize, Pixmap};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputKind {
    #[default]
    Srt,
    Udp,
    Rtmp,
    Hls,
    Rtsp,
    /// Any address or file ffmpeg reads.
    Url,
    Ndi,
    Sdi,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: InputKind,
    /// `srt://host:port`, `udp://@239.1.1.1:5000`, `rtmp://server/app/key`,
    /// `https://…/index.m3u8`, `rtsp://…`.
    #[serde(default)]
    pub url: String,
    /// SRT / RTMP: wait for the sender to connect instead of calling it.
    #[serde(default)]
    pub listen: bool,
    /// NDI: the source name ("HOST (name)").
    #[serde(default)]
    pub ndi_source: String,
    /// SDI: DeckLink device index.
    #[serde(default)]
    pub device: u32,
    /// Streams are decoded at this size (the picture fitted inside) and rate.
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
    #[serde(default = "default_fps")]
    pub fps: u32,
    /// Smoothing, in frames of delay (0: shown as soon as they come).
    #[serde(default = "default_buffer")]
    pub buffer: u32,
    /// Streams: decode on the graphics card when ffmpeg can (it falls back
    /// to the processor).
    #[serde(default)]
    pub hw_decode: bool,
}

fn default_buffer() -> u32 {
    2
}

fn default_width() -> u32 {
    1920
}
fn default_height() -> u32 {
    1080
}
fn default_fps() -> u32 {
    25
}

impl InputConfig {
    /// The ffmpeg arguments that decode this stream to raw RGBA on stdout.
    pub fn ffmpeg_args(&self) -> Result<Vec<String>, String> {
        let url = self.url.trim();
        if url.is_empty() {
            return Err("no address".into());
        }
        let need = |schemes: &[&str]| -> Result<(), String> {
            if schemes
                .iter()
                .any(|s| url.to_ascii_lowercase().starts_with(s))
            {
                Ok(())
            } else {
                Err(format!(
                    "the address must start with {}",
                    schemes.join(" or ")
                ))
            }
        };
        // Low latency, and a short look at the stream before the pictures start.
        let mut a: Vec<String> = [
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-probesize",
            "500000",
            "-analyzeduration",
            "1000000",
        ]
        .map(String::from)
        .to_vec();
        let mut url = url.to_string();
        match self.kind {
            InputKind::Srt => {
                need(&["srt://"])?;
                if self.listen && !url.contains("mode=") {
                    url.push(if url.contains('?') { '&' } else { '?' });
                    url.push_str("mode=listener");
                }
            }
            InputKind::Udp => need(&["udp://", "rtp://"])?,
            InputKind::Rtmp => {
                need(&["rtmp://", "rtmps://"])?;
                if self.listen {
                    a.extend(["-listen", "1"].map(String::from));
                }
            }
            InputKind::Hls => need(&["http://", "https://"])?,
            InputKind::Rtsp => {
                need(&["rtsp://", "rtsps://"])?;
                a.extend(["-rtsp_transport", "tcp"].map(String::from));
            }
            InputKind::Url => {}
            InputKind::Ndi | InputKind::Sdi => return Err("not a stream".into()),
        }
        let (w, h) = (self.width.clamp(16, 7680), self.height.clamp(16, 4320));
        if self.hw_decode {
            a.extend(["-hwaccel", "auto"].map(String::from));
        }
        a.extend(["-i".into(), url, "-an".into(), "-vf".into()]);
        a.push(format!(
            "fps={},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0",
            self.fps.clamp(1, 60)
        ));
        a.extend(["-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"].map(String::from));
        Ok(a)
    }
}

/// How an input is doing, for the Video streams page.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputStatus {
    pub id: String,
    /// A picture came in the last two seconds.
    pub live: bool,
    pub message: String,
    pub width: u32,
    pub height: u32,
    /// Pictures received since the input started.
    pub frames: u64,
}

/// Pictures waiting for their time, and the one on show.
#[derive(Default)]
struct Paced {
    queue: VecDeque<(Instant, Arc<Pixmap>)>,
    shown: Option<Arc<Pixmap>>,
    last_due: Option<Instant>,
}

/// One running input.
struct Live {
    config: InputConfig,
    /// The newest picture (previews, status).
    picture: RwLock<Option<Arc<Pixmap>>>,
    paced: Mutex<Paced>,
    /// Picture buffers done with, used again.
    pool: Mutex<Vec<Vec<u8>>>,
    received: AtomicU64,
    /// Thrown away: too many waiting.
    dropped: AtomicU64,
    last_at: Mutex<Option<std::time::Instant>>,
    message: Mutex<String>,
    stop: AtomicBool,
    /// The ffmpeg decoding it (killed to stop a blocked read).
    child: Mutex<Option<Child>>,
}

impl Live {
    fn say(&self, m: impl Into<String>) {
        *self.message.lock().unwrap_or_else(|p| p.into_inner()) = m.into();
    }
    fn period(&self) -> Duration {
        Duration::from_secs_f64(1.0 / self.config.fps.clamp(1, 120) as f64)
    }

    fn put(&self, pm: Pixmap) {
        let now = Instant::now();
        let pm = Arc::new(pm);
        *self.picture.write().unwrap_or_else(|p| p.into_inner()) = Some(pm.clone());
        self.received.fetch_add(1, Ordering::Relaxed);
        *self.last_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(now);
        let (period, frames) = (self.period(), self.config.buffer.min(10));
        let delay = period * frames;
        let mut p = self.paced.lock().unwrap_or_else(|p| p.into_inner());
        // Time goes on even when nothing draws this input.
        self.advance(&mut p, now);
        let mut due = now + delay;
        if frames > 0 {
            // At least a frame after the previous one: bursts spread out.
            if let Some(next) = p.last_due.map(|d| d + period) {
                due = due.max(next);
            }
            // Further and further behind (a sender faster than its rate):
            // start again from now.
            if due > now + delay + period * 3 {
                due = now + delay;
                let n = p.queue.len() as u64;
                p.queue.clear();
                self.dropped.fetch_add(n, Ordering::Relaxed);
            }
        }
        p.last_due = Some(due);
        p.queue.push_back((due, pm));
        while p.queue.len() > frames as usize + 3 {
            if let Some((_, old)) = p.queue.pop_front() {
                self.recycle(old);
            }
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The picture to show now.
    fn current(&self) -> Option<Arc<Pixmap>> {
        let mut p = self.paced.lock().unwrap_or_else(|p| p.into_inner());
        self.advance(&mut p, Instant::now());
        p.shown.clone()
    }

    /// Shows the pictures whose time has come.
    fn advance(&self, p: &mut Paced, now: Instant) {
        while p.queue.front().is_some_and(|(due, _)| *due <= now) {
            let Some((_, pm)) = p.queue.pop_front() else {
                break;
            };
            if let Some(old) = p.shown.replace(pm) {
                self.recycle(old);
            }
        }
    }

    /// Keeps the buffer of a picture nobody holds any more.
    fn recycle(&self, pm: Arc<Pixmap>) {
        if let Ok(pm) = Arc::try_unwrap(pm) {
            let mut pool = self.pool.lock().unwrap_or_else(|p| p.into_inner());
            if pool.len() < 4 {
                pool.push(pm.take());
            }
        }
    }

    /// A buffer for the next picture.
    fn buffer(&self, size: usize) -> Vec<u8> {
        let mut pool = self.pool.lock().unwrap_or_else(|p| p.into_inner());
        while let Some(b) = pool.pop() {
            if b.len() == size {
                return b;
            }
        }
        vec![0u8; size]
    }
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
    /// Sleeps `d` unless stopped meanwhile (then false).
    fn pause(&self, d: Duration) -> bool {
        let until = std::time::Instant::now() + d;
        while std::time::Instant::now() < until {
            if self.stopped() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        !self.stopped()
    }
    fn halt(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(c) = self
            .child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
        {
            let _ = c.kill();
        }
    }
}

/// The live inputs of the server.
#[derive(Default)]
pub struct Inputs {
    live: RwLock<BTreeMap<String, Arc<Live>>>,
}

impl Inputs {
    /// Runs the configured inputs: new and changed ones start, removed ones stop.
    pub fn apply(&self, configs: &[InputConfig]) {
        let mut map = self.live.write().unwrap_or_else(|p| p.into_inner());
        map.retain(|id, l| {
            let keep = configs.iter().any(|c| &c.id == id && *c == l.config);
            if !keep {
                l.halt();
            }
            keep
        });
        for c in configs {
            if map.contains_key(&c.id) || c.id.is_empty() {
                continue;
            }
            let live = Arc::new(Live {
                config: c.clone(),
                picture: RwLock::new(None),
                paced: Mutex::new(Paced::default()),
                pool: Mutex::new(Vec::new()),
                received: AtomicU64::new(0),
                dropped: AtomicU64::new(0),
                last_at: Mutex::new(None),
                message: Mutex::new("Starting…".into()),
                stop: AtomicBool::new(false),
                child: Mutex::new(None),
            });
            let l = live.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("cg-input-{}", c.id))
                .spawn(move || match l.config.kind {
                    InputKind::Ndi => run_ndi(&l),
                    InputKind::Sdi => {
                        l.say("DeckLink support is not built into this server (`decklink` feature)")
                    }
                    _ => run_stream(&l),
                });
            if let Err(e) = spawned {
                live.say(format!("cannot start: {e}"));
            }
            map.insert(c.id.clone(), live);
        }
    }

    pub fn status(&self) -> Vec<InputStatus> {
        let map = self.live.read().unwrap_or_else(|p| p.into_inner());
        map.values()
            .map(|l| {
                let pic = l.picture.read().unwrap_or_else(|p| p.into_inner()).clone();
                let fresh = l
                    .last_at
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(2));
                InputStatus {
                    id: l.config.id.clone(),
                    live: fresh,
                    message: l.message.lock().unwrap_or_else(|p| p.into_inner()).clone(),
                    width: pic.as_ref().map_or(0, |p| p.width()),
                    height: pic.as_ref().map_or(0, |p| p.height()),
                    frames: l.received.load(Ordering::Relaxed),
                }
            })
            .collect()
    }

    /// What the load sampler counts.
    pub fn counts(&self) -> Vec<crate::perf::InputCounts> {
        let map = self.live.read().unwrap_or_else(|p| p.into_inner());
        map.values()
            .map(|l| crate::perf::InputCounts {
                id: l.config.id.clone(),
                received: l.received.load(Ordering::Relaxed),
                dropped: l.dropped.load(Ordering::Relaxed),
                pid: l
                    .child
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                    .map(|c| c.id()),
            })
            .collect()
    }

    /// Pictures received so far (changes when a new one comes).
    pub fn received(&self, id: &str) -> Option<u64> {
        let map = self.live.read().unwrap_or_else(|p| p.into_inner());
        map.get(id).map(|l| l.received.load(Ordering::Relaxed))
    }

    pub fn exists(&self, id: &str) -> bool {
        self.live
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(id)
    }
}

impl cg_render::LiveInputs for Inputs {
    fn picture(&self, id: &str) -> Option<Arc<Pixmap>> {
        let live = self
            .live
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)?
            .clone();
        live.current()
    }
}

impl Drop for Inputs {
    fn drop(&mut self) {
        for l in self.live.read().unwrap_or_else(|p| p.into_inner()).values() {
            l.halt();
        }
    }
}

// ------------------------------------------------------------------ API --

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::api::{not_found, require, ApiResult};
use crate::auth::{CurrentUser, MaybeUser};
use crate::state::Shared;

/// An input as the Video widget and the Video streams page list it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputInfo {
    /// `id` comes with the status.
    pub name: String,
    pub kind: InputKind,
    #[serde(flatten)]
    pub status: InputStatus,
}

/// `GET /api/inputs`: every input with how it is doing (public like the
/// HTML5 outputs when they are, since their Video layers need it).
pub async fn list(
    State(s): State<Shared>,
    MaybeUser(me): MaybeUser,
) -> ApiResult<Json<Vec<InputInfo>>> {
    require(me.is_some() || s.config.public_outputs)?;
    let status = s.inputs.status();
    Ok(Json(
        s.config
            .inputs
            .iter()
            .map(|c| InputInfo {
                name: c.name.clone(),
                kind: c.kind,
                status: status
                    .iter()
                    .find(|x| x.id == c.id)
                    .cloned()
                    .unwrap_or_else(|| InputStatus {
                        id: c.id.clone(),
                        message: "Not started (save the settings)".into(),
                        ..Default::default()
                    }),
            })
            .collect(),
    ))
}

/// `GET /api/inputs/ndi-sources`: the NDI sources seen on the network.
pub async fn ndi_sources(CurrentUser(me): CurrentUser) -> ApiResult<Json<Vec<String>>> {
    require(me.is_admin())?;
    tokio::task::spawn_blocking(|| cg_output::ndi::sources(1500))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))
}

#[derive(Deserialize)]
pub struct PreviewQuery {
    /// Largest width of the pictures sent.
    #[serde(default)]
    w: Option<u32>,
}

/// `GET /api/inputs/<id>/live.mjpeg`: the input as Motion JPEG, for the
/// previews and the HTML5 outputs (public like them when they are).
pub async fn mjpeg(
    State(s): State<Shared>,
    MaybeUser(me): MaybeUser,
    UrlPath(id): UrlPath<String>,
    Query(q): Query<PreviewQuery>,
) -> Response {
    if me.is_none() && !s.config.public_outputs {
        return (StatusCode::UNAUTHORIZED, "sign in").into_response();
    }
    if !s.inputs.exists(&id) {
        return not_found("input").into_response();
    }
    let width = q.w.unwrap_or(1280).clamp(64, 3840);
    let hub = s.inputs.clone();
    let mut closing = s.closing.subscribe();
    let stream = futures_util::stream::unfold((hub, id, None::<u64>), move |(hub, id, last)| {
        let stop = *closing.borrow_and_update();
        async move {
            if stop {
                return None;
            }
            // The next picture (one at least every 2 s, so the page knows it is alive).
            let mut waited = 0;
            loop {
                let n = hub.received(&id)?;
                if Some(n) != last || waited >= 2000 {
                    let pic = cg_render::LiveInputs::picture(hub.as_ref(), &id);
                    let jpeg = match pic {
                        Some(p) => {
                            tokio::task::spawn_blocking(move || cg_render::jpeg(&p, width, 78))
                                .await
                                .ok()
                                .flatten()
                        }
                        None => None,
                    };
                    let Some(jpeg) = jpeg else {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        waited += 200;
                        if waited >= 2000 {
                            waited = 0;
                        }
                        continue;
                    };
                    let mut part = format!(
                        "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                        jpeg.len()
                    )
                    .into_bytes();
                    part.extend_from_slice(&jpeg);
                    part.extend_from_slice(b"\r\n");
                    return Some((
                        Ok::<_, std::io::Error>(axum::body::Bytes::from(part)),
                        (hub, id, Some(n)),
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                waited += 20;
            }
        }
    });
    (
        [
            (
                header::CONTENT_TYPE,
                "multipart/x-mixed-replace; boundary=frame",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

/// A stream through ffmpeg, started again 2 s after it stops.
fn run_stream(l: &Live) {
    let c = &l.config;
    let args = match c.ffmpeg_args() {
        Ok(a) => a,
        Err(e) => return l.say(e),
    };
    let (w, h) = (c.width.clamp(16, 7680), c.height.clamp(16, 4320));
    let size = (w * h * 4) as usize;
    while !l.stopped() {
        let spawned = cg_output::ffmpeg::command()
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                l.say(format!("ffmpeg is needed for stream inputs ({e})"));
                if !l.pause(Duration::from_secs(5)) {
                    return;
                }
                continue;
            }
        };
        l.say(if c.listen {
            "Waiting for the sender…"
        } else {
            "Connecting…"
        });
        let mut out = child.stdout.take();
        let log = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = child.stderr.take() {
            let log = log.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut s = log.lock().unwrap_or_else(|p| p.into_inner());
                    s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if s.len() > 8192 {
                        let cut = s.len() - 4096;
                        *s = s[s.ceil_char_boundary(cut)..].to_string();
                    }
                }
            });
        }
        *l.child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
        if let Some(out) = out.as_mut() {
            let mut first = true;
            loop {
                let mut buf = l.buffer(size);
                if out.read_exact(&mut buf).is_err() || l.stopped() {
                    break;
                }
                // ffmpeg pads with transparent black: already premultiplied.
                if let Some(pm) = IntSize::from_wh(w, h).and_then(|s| Pixmap::from_vec(buf, s)) {
                    l.put(pm);
                }
                if first {
                    first = false;
                    l.say(format!("Receiving {w}×{h}"));
                }
            }
        }
        if let Some(mut c) = l.child.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if l.stopped() {
            return;
        }
        let why = cg_output::ffmpeg::tail(&log.lock().unwrap_or_else(|p| p.into_inner()));
        l.say(format!("Stopped: {why} — trying again"));
        if !l.pause(Duration::from_secs(2)) {
            return;
        }
    }
}

/// An NDI source, connected again when it goes away.
fn run_ndi(l: &Live) {
    let source = l.config.ndi_source.trim().to_string();
    if source.is_empty() {
        return l.say("no NDI source chosen");
    }
    while !l.stopped() {
        let mut rx = match cg_output::ndi::NdiReceiver::open(&source) {
            Ok(r) => r,
            Err(e) => {
                l.say(e);
                if !l.pause(Duration::from_secs(5)) {
                    return;
                }
                continue;
            }
        };
        l.say(format!("Connecting to {source}…"));
        let mut first = true;
        while !l.stopped() {
            let mut pic = None;
            match rx.capture(500, |f| pic = premultiplied(&f)) {
                Ok(_) => {}
                Err(e) => {
                    l.say(format!("{e} — trying again"));
                    break;
                }
            }
            if let Some(pm) = pic {
                if first {
                    first = false;
                    l.say(format!("Receiving {}×{}", pm.width(), pm.height()));
                }
                l.put(pm);
            }
        }
        drop(rx);
        if !l.pause(Duration::from_secs(1)) {
            return;
        }
    }
}

/// An NDI picture (straight alpha, padded rows) as a premultiplied pixmap.
fn premultiplied(f: &cg_output::ndi::Received) -> Option<Pixmap> {
    let (w, h) = (f.width as usize, f.height as usize);
    let mut data = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        let row = f.data.get(y * f.stride..y * f.stride + w * 4)?;
        for p in row.as_chunks::<4>().0 {
            if !f.alpha || p[3] == 255 {
                data.extend_from_slice(&[p[0], p[1], p[2], 255]);
            } else {
                let a = p[3] as u32;
                let m = |c: u8| ((c as u32 * a + 127) / 255) as u8;
                data.extend_from_slice(&[m(p[0]), m(p[1]), m(p[2]), p[3]]);
            }
        }
    }
    Pixmap::from_vec(data, IntSize::from_wh(f.width, f.height)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: InputKind, url: &str, listen: bool) -> InputConfig {
        InputConfig {
            id: "in-1".into(),
            name: "Cam".into(),
            kind,
            url: url.into(),
            listen,
            ndi_source: String::new(),
            device: 0,
            width: 1280,
            height: 720,
            fps: 25,
            buffer: 2,
            hw_decode: false,
        }
    }

    fn live(fps: u32, buffer: u32) -> Live {
        let mut config = input(InputKind::Udp, "udp://127.0.0.1:1", false);
        (config.fps, config.buffer) = (fps, buffer);
        Live {
            config,
            picture: RwLock::new(None),
            paced: Mutex::new(Paced::default()),
            pool: Mutex::new(Vec::new()),
            received: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            last_at: Mutex::new(None),
            message: Mutex::new(String::new()),
            stop: AtomicBool::new(false),
            child: Mutex::new(None),
        }
    }

    fn pic(w: u32) -> Pixmap {
        Pixmap::new(w, 1).unwrap()
    }

    /// Three pictures arriving at once come out one frame apart, after the buffer.
    #[test]
    fn a_burst_is_spread_out() {
        let l = live(20, 2); // 50 ms frames, 100 ms buffer
        for w in 1..=3 {
            l.put(pic(w));
        }
        assert!(l.current().is_none());
        std::thread::sleep(Duration::from_millis(110));
        assert_eq!(l.current().unwrap().width(), 1);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(l.current().unwrap().width(), 2);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(l.current().unwrap().width(), 3);
        // Nothing new: the last one stays.
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(l.current().unwrap().width(), 3);
        assert_eq!(l.dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn no_buffer_shows_at_once_and_too_many_are_dropped() {
        let l = live(25, 0);
        l.put(pic(1));
        assert_eq!(l.current().unwrap().width(), 1);
        let l = live(25, 1);
        for w in 1..=8 {
            l.put(pic(w));
        }
        // At most buffer + 3 wait.
        assert_eq!(l.dropped.load(Ordering::Relaxed), 4);
    }

    /// Pictures at their rate, nothing drawing them: none is thrown away.
    #[test]
    fn an_input_nobody_shows_drops_nothing() {
        let l = live(50, 2);
        for w in 1..=12 {
            l.put(pic(w));
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(l.dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn stream_addresses() {
        let a = input(InputKind::Srt, "srt://0.0.0.0:9000", true)
            .ffmpeg_args()
            .unwrap();
        assert!(a.contains(&"srt://0.0.0.0:9000?mode=listener".to_string()));
        let a = input(InputKind::Rtmp, "rtmp://0.0.0.0/live/cam", true)
            .ffmpeg_args()
            .unwrap();
        assert!(a.windows(2).any(|w| w == ["-listen", "1"]));
        assert!(input(InputKind::Hls, "srt://x", false)
            .ffmpeg_args()
            .is_err());
        assert!(input(InputKind::Udp, "", false).ffmpeg_args().is_err());
        let a = input(InputKind::Udp, "udp://@239.1.1.1:5000", false)
            .ffmpeg_args()
            .unwrap();
        assert!(a.iter().any(|x| x.contains("scale=1280:720")));
    }

    #[test]
    fn ndi_pictures_are_premultiplied() {
        // One row of 2 pixels, padded to 12 bytes.
        let data = [200, 100, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        let f = cg_output::ndi::Received {
            width: 2,
            height: 1,
            stride: 12,
            alpha: true,
            data: &data,
        };
        let pm = premultiplied(&f).unwrap();
        assert_eq!(pm.data(), &[100, 50, 0, 128, 10, 20, 30, 255]);
    }

    /// A stream sent by ffmpeg comes back as pictures (needs ffmpeg).
    #[test]
    fn a_udp_stream_is_received() {
        if cg_output::ffmpeg::command()
            .arg("-version")
            .output()
            .is_err()
        {
            return;
        }
        let port = 47_000 + (std::process::id() % 1000) as u16;
        let hub = Inputs::default();
        hub.apply(&[InputConfig {
            width: 320,
            height: 180,
            ..input(InputKind::Udp, &format!("udp://127.0.0.1:{port}"), false)
        }]);
        let mut send = cg_output::ffmpeg::command()
            .args([
                "-re",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=25",
                "-t",
                "8",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-g",
                "25",
                "-f",
                "mpegts",
            ])
            .arg(format!("udp://127.0.0.1:{port}?pkt_size=1316"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut got = false;
        for _ in 0..80 {
            std::thread::sleep(Duration::from_millis(100));
            if hub.received("in-1").unwrap_or(0) > 3 {
                got = true;
                break;
            }
        }
        let _ = send.kill();
        let _ = send.wait();
        assert!(got, "no picture: {:?}", hub.status());
        // Shown after the smoothing buffer.
        let mut pic = None;
        for _ in 0..50 {
            pic = cg_render::LiveInputs::picture(&hub, "in-1");
            if pic.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let pic = pic.unwrap();
        assert_eq!((pic.width(), pic.height()), (320, 180));
        assert!(hub.status()[0].message.starts_with("Receiving"));
    }

    /// A stream output of Strata comes back through an input (needs ffmpeg).
    #[test]
    fn a_stream_output_comes_back_as_an_input() {
        use cg_output::OutputSink;
        if cg_output::ffmpeg::command()
            .arg("-version")
            .output()
            .is_err()
        {
            return;
        }
        let port = 48_000 + (std::process::id() % 1000) as u16;
        let hub = Inputs::default();
        hub.apply(&[InputConfig {
            width: 320,
            height: 180,
            ..input(InputKind::Udp, &format!("udp://127.0.0.1:{port}"), false)
        }]);
        let mut out = cg_output::stream::StreamSender::open(
            cg_output::stream::StreamConfig {
                id: "s".into(),
                name: "S".into(),
                protocol: cg_output::stream::Protocol::Udp,
                url: format!("udp://127.0.0.1:{port}"),
                listen: false,
                bitrate: 2000,
                codec: cg_output::stream::Codec::H264,
                background: "#0000ff".into(),
                audio: false,
            },
            320,
            180,
            (25, 1),
            None,
        )
        .unwrap();
        // Transparent graphics over the blue background.
        let frame = Arc::new(cg_render::Frame::blank(320, 180));
        let mut got = false;
        for _ in 0..200 {
            let _ = out.push(&frame, std::time::SystemTime::now());
            std::thread::sleep(Duration::from_millis(40));
            if hub.received("in-1").unwrap_or(0) > 5 {
                got = true;
                break;
            }
        }
        assert!(got, "no picture: {:?}", hub.status());
        let pic = cg_render::LiveInputs::picture(&hub, "in-1").unwrap();
        let p = pic.pixel(160, 90).unwrap();
        assert!(p.blue() > 200 && p.red() < 40 && p.green() < 40, "{p:?}");
    }
}
