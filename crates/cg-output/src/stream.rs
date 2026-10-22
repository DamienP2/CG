//! Stream outputs: SRT, UDP (MPEG-TS), RTMP and HLS, encoded by ffmpeg.
//!
//! The picture is laid over a background colour (these streams carry no
//! alpha), sent to ffmpeg as raw RGB and encoded in H.264 (or HEVC), with a
//! silent audio track when asked (most RTMP platforms want one). If ffmpeg
//! stops (the receiver went away, the network dropped), it is started again
//! two seconds later; meanwhile the output reports why.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cg_render::Frame;
use serde::{Deserialize, Serialize};

use crate::{ffmpeg, OutputError, OutputSink};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    #[default]
    Srt,
    Udp,
    Rtmp,
    /// Served by Strata (`/hls/<channel>/<output>/index.m3u8`).
    Hls,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Codec {
    #[default]
    H264,
    Hevc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamConfig {
    #[serde(default)]
    pub id: String,
    /// Off: kept in the settings, not started.
    #[serde(default = "crate::on")]
    pub enabled: bool,
    pub name: String,
    #[serde(default)]
    pub protocol: Protocol,
    /// `srt://host:port`, `udp://239.1.1.1:5000`, `rtmp://server/app/key`
    /// (none for HLS).
    #[serde(default)]
    pub url: String,
    /// SRT: wait for the receivers to call (listener) instead of calling them.
    #[serde(default)]
    pub listen: bool,
    /// Video bit rate, kbit/s.
    #[serde(default = "default_bitrate")]
    pub bitrate: u32,
    #[serde(default)]
    pub codec: Codec,
    /// What shows where the graphics are transparent.
    #[serde(default = "default_background")]
    pub background: String,
    /// A silent stereo track.
    #[serde(default = "yes")]
    pub audio: bool,
    /// Encode on the graphics card when this machine has an encoder ffmpeg
    /// can use (VideoToolbox on a Mac, NVENC, Quick Sync, AMF), else on the
    /// processor.
    #[serde(default)]
    pub hw_encode: bool,
}

/// The encoder of a stream: a hardware one this machine has, when asked
/// for, else x264 / x265.
pub fn encoder(codec: Codec, hardware: bool) -> &'static str {
    if hardware {
        if let Some(e) = hardware_encoder(codec) {
            return e;
        }
        tracing::warn!(
            ?codec,
            "no hardware encoder usable here: encoding on the processor"
        );
    }
    match codec {
        Codec::H264 => "libx264",
        Codec::Hevc => "libx265",
    }
}

/// The first hardware encoder that really encodes here (a build may list
/// NVENC without an NVIDIA card): each one tried once, on a few frames.
fn hardware_encoder(codec: Codec) -> Option<&'static str> {
    static FOUND: std::sync::OnceLock<
        Mutex<std::collections::HashMap<Codec, Option<&'static str>>>,
    > = std::sync::OnceLock::new();
    let found = FOUND.get_or_init(Default::default);
    let mut found = found.lock().unwrap_or_else(|p| p.into_inner());
    *found.entry(codec).or_insert_with(|| {
        let candidates: &[&'static str] = match (codec, cfg!(target_os = "macos")) {
            (Codec::H264, true) => &["h264_videotoolbox"],
            (Codec::Hevc, true) => &["hevc_videotoolbox"],
            (Codec::H264, false) => &["h264_nvenc", "h264_qsv", "h264_amf"],
            (Codec::Hevc, false) => &["hevc_nvenc", "hevc_qsv", "hevc_amf"],
        };
        let works = |e: &str| {
            ffmpeg::command()
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:s=320x180:r=25",
                    "-frames:v",
                    "10",
                ])
                .args(["-pix_fmt", "nv12", "-c:v", e, "-f", "null", "-"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        let e = candidates.iter().copied().find(|e| works(e));
        tracing::info!(?codec, encoder = e.unwrap_or("none"), "hardware encoder");
        e
    })
}

/// Settings of an encoder for live streaming (low latency, constant rate).
fn encoder_args(encoder: &str) -> Vec<&'static str> {
    match encoder {
        "libx264" => vec![
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
        ],
        "libx265" => vec![
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
        ],
        e if e.ends_with("_videotoolbox") => {
            vec!["-realtime", "1", "-allow_sw", "1", "-pix_fmt", "nv12"]
        }
        e if e.ends_with("_nvenc") => vec![
            "-preset", "p2", "-tune", "ll", "-rc", "cbr", "-pix_fmt", "nv12",
        ],
        e if e.ends_with("_qsv") => vec!["-preset", "veryfast", "-pix_fmt", "nv12"],
        e if e.ends_with("_amf") => vec![
            "-usage",
            "lowlatency",
            "-quality",
            "speed",
            "-rc",
            "cbr",
            "-pix_fmt",
            "nv12",
        ],
        _ => vec!["-pix_fmt", "yuv420p"],
    }
}

fn default_bitrate() -> u32 {
    8000
}
fn default_background() -> String {
    "#000000".into()
}
fn yes() -> bool {
    true
}

impl StreamConfig {
    /// The address ffmpeg sends to, checked for the protocol.
    pub fn target(&self) -> Result<String, String> {
        let url = self.url.trim();
        let need = |scheme: &str| -> Result<(), String> {
            if url.to_ascii_lowercase().starts_with(scheme) {
                Ok(())
            } else {
                Err(format!("the address must start with {scheme}"))
            }
        };
        match self.protocol {
            Protocol::Hls => Ok(String::new()),
            Protocol::Udp => {
                need("udp://")?;
                Ok(if url.contains('?') {
                    url.to_string()
                } else {
                    format!("{url}?pkt_size=1316")
                })
            }
            Protocol::Srt => {
                need("srt://")?;
                Ok(if self.listen && !url.contains("mode=") {
                    format!(
                        "{url}{}mode=listener",
                        if url.contains('?') { '&' } else { '?' }
                    )
                } else {
                    url.to_string()
                })
            }
            Protocol::Rtmp => {
                if !(url.starts_with("rtmp://") || url.starts_with("rtmps://")) {
                    return Err("the address must start with rtmp:// or rtmps://".into());
                }
                Ok(url.to_string())
            }
        }
    }
}

/// The ffmpeg arguments after the global ones.
pub fn args(
    c: &StreamConfig,
    width: u32,
    height: u32,
    rate: (u32, u32),
    hls_dir: Option<&std::path::Path>,
    encoder: &str,
) -> Result<Vec<String>, String> {
    let target = c.target()?;
    let fps = rate.0 as f64 / rate.1.max(1) as f64;
    let gop = (fps * 2.0).round().max(1.0) as u32;
    let b = c.bitrate.clamp(200, 100_000);
    let mut a: Vec<String> = [
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        &format!("{width}x{height}"),
        "-framerate",
        &format!("{}/{}", rate.0, rate.1.max(1)),
        "-i",
        "pipe:0",
    ]
    .map(String::from)
    .to_vec();
    if c.audio {
        a.extend(
            [
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=48000",
            ]
            .map(String::from),
        );
        a.extend(["-map", "0:v", "-map", "1:a"].map(String::from));
    }
    a.extend(["-c:v".to_string(), encoder.to_string()]);
    a.extend(encoder_args(encoder).into_iter().map(String::from));
    a.extend([
        "-b:v".into(),
        format!("{b}k"),
        "-maxrate".into(),
        format!("{b}k"),
        "-bufsize".into(),
        format!("{}k", b * 2),
        "-g".into(),
        gop.to_string(),
        "-keyint_min".into(),
        gop.to_string(),
    ]);
    if c.audio {
        a.extend(["-c:a", "aac", "-b:a", "128k", "-ar", "48000"].map(String::from));
    }
    match c.protocol {
        Protocol::Udp | Protocol::Srt => a.extend(["-f".into(), "mpegts".into(), target]),
        Protocol::Rtmp => a.extend(["-f".into(), "flv".into(), target]),
        Protocol::Hls => {
            let dir = hls_dir.ok_or("no folder for the HLS stream")?;
            a.extend([
                "-f".into(),
                "hls".into(),
                "-hls_time".into(),
                "2".into(),
                "-hls_list_size".into(),
                "6".into(),
                "-hls_flags".into(),
                "delete_segments+independent_segments".into(),
                "-hls_segment_filename".into(),
                dir.join("seg-%05d.ts").to_string_lossy().into_owned(),
                dir.join("index.m3u8").to_string_lossy().into_owned(),
            ]);
        }
    }
    Ok(a)
}

/// The premultiplied RGBA picture over `bg`, as RGB.
pub fn over_background(frame: &Frame, bg: [u8; 3], out: &mut Vec<u8>) {
    out.resize(frame.data.len() / 4 * 3, 0);
    over_background_into(&frame.data, bg, out);
}

/// The same into `out`, which holds the conversion of `from` (when Some):
/// only the rows that differ from it are converted again.
pub fn over_background_from(frame: &Frame, from: Option<&Frame>, bg: [u8; 3], out: &mut Vec<u8>) {
    let len = frame.data.len() / 4 * 3;
    let rows = crate::changed_rows(frame, from).filter(|_| out.len() == len);
    let Some(rows) = rows else {
        return over_background(frame, bg, out);
    };
    let (w, w3) = (frame.width as usize * 4, frame.width as usize * 3);
    for (y, _) in rows.iter().enumerate().filter(|(_, c)| **c) {
        over_background_into(
            &frame.data[y * w..(y + 1) * w],
            bg,
            &mut out[y * w3..(y + 1) * w3],
        );
    }
}

/// The same for pixels `rgba` into `out` (3 bytes a pixel).
fn over_background_into(rgba: &[u8], bg: [u8; 3], out: &mut [u8]) {
    let px = rgba.as_chunks::<4>().0;
    for (p, o) in px.iter().zip(out.as_chunks_mut::<3>().0) {
        match p[3] {
            // Most of a graphics picture: nothing, or opaque.
            0 => *o = bg,
            255 => *o = [p[0], p[1], p[2]],
            a => {
                let inv = 255 - a as u32;
                for i in 0..3 {
                    o[i] = (p[i] as u32 + (bg[i] as u32 * inv + 127) / 255).min(255) as u8;
                }
            }
        }
    }
}

fn hex_rgb(s: &str) -> [u8; 3] {
    let h = s.trim().trim_start_matches('#');
    let v = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    if h.len() >= 6 {
        [v(0), v(2), v(4)]
    } else {
        [0, 0, 0]
    }
}

pub struct StreamSender {
    config: StreamConfig,
    tx: Option<SyncSender<Arc<Vec<u8>>>>,
    /// Buffers ffmpeg is done with, used again (no 6 MB allocation a frame).
    spare: Receiver<Arc<Vec<u8>>>,
    /// The picture sent last and its conversion (the same picture again,
    /// nothing moved: sent again as it is).
    last: Option<(Arc<Frame>, Arc<Vec<u8>>)>,
    /// The picture each buffer in use holds (by its address): one coming
    /// back is converted again only where the new picture differs.
    made: Vec<(usize, Arc<Frame>)>,
    error: Arc<Mutex<Option<String>>>,
    bg: [u8; 3],
    worker: Option<std::thread::JoinHandle<()>>,
    /// The running ffmpeg, so closing can stop one that does not read (a
    /// listener nobody called yet).
    child: Slot,
}

type Slot = Arc<Mutex<Option<Child>>>;

impl StreamSender {
    /// Starts ffmpeg for this output (`hls_dir`: where an HLS stream is written).
    pub fn open(
        config: StreamConfig,
        width: u32,
        height: u32,
        rate: (u32, u32),
        hls_dir: Option<PathBuf>,
    ) -> Result<Self, OutputError> {
        let enc = encoder(config.codec, config.hw_encode);
        let args = args(&config, width, height, rate, hls_dir.as_deref(), enc)
            .map_err(OutputError::Unsupported)?;
        tracing::info!(name = config.name, encoder = enc, "stream encoder");
        if let Some(dir) = &hls_dir {
            let _ = std::fs::remove_dir_all(dir);
            std::fs::create_dir_all(dir)?;
        }
        // ffmpeg must be there before anything is promised.
        ffmpeg::command()
            .arg("-version")
            .stdout(Stdio::null())
            .status()
            .map_err(|e| {
                OutputError::Unsupported(format!("ffmpeg is needed for stream outputs ({e})"))
            })?;
        let (tx, rx) = mpsc::sync_channel::<Arc<Vec<u8>>>(2);
        let (back, spare) = mpsc::sync_channel::<Arc<Vec<u8>>>(3);
        let error = Arc::new(Mutex::new(None));
        let child = Slot::default();
        let worker = std::thread::Builder::new()
            .name(format!("cg-stream-{}", config.id))
            .spawn({
                let (error, name, slot) = (error.clone(), config.name.clone(), child.clone());
                move || run(args, rx, back, error, name, slot)
            })?;
        tracing::info!(name = config.name, protocol = ?config.protocol, "stream output started");
        Ok(Self {
            bg: hex_rgb(&config.background),
            config,
            tx: Some(tx),
            spare,
            last: None,
            made: Vec::new(),
            error,
            worker: Some(worker),
            child,
        })
    }
}

/// Feeds ffmpeg until the output is closed, starting it again when it stops.
fn run(
    args: Vec<String>,
    rx: Receiver<Arc<Vec<u8>>>,
    back: SyncSender<Arc<Vec<u8>>>,
    error: Arc<Mutex<Option<String>>>,
    name: String,
    slot: Slot,
) {
    let set = |e: Option<String>| *error.lock().unwrap_or_else(|p| p.into_inner()) = e;
    let child = || slot.lock().unwrap_or_else(|p| p.into_inner());
    let stop = || {
        if let Some(mut c) = child().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    };
    loop {
        let spawned: Result<Child, _> = ffmpeg::command()
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn();
        let mut c = match spawned {
            Ok(c) => c,
            Err(e) => {
                set(Some(format!("ffmpeg cannot start: {e}")));
                if !wait(&rx, Duration::from_secs(3)) {
                    return;
                }
                continue;
            }
        };
        let log = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = c.stderr.take() {
            let log = log.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut l = log.lock().unwrap_or_else(|p| p.into_inner());
                    l.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if l.len() > 8192 {
                        let cut = l.len() - 4096;
                        *l = l[l.ceil_char_boundary(cut)..].to_string();
                    }
                }
            });
        }
        let Some(mut stdin) = c.stdin.take() else {
            let _ = c.kill();
            return;
        };
        *child() = Some(c);
        set(None);
        let closed = loop {
            match rx.recv() {
                Ok(buf) => {
                    if stdin.write_all(&buf).is_err() {
                        break false;
                    }
                    let _ = back.try_send(buf);
                }
                Err(_) => break true,
            }
        };
        drop(stdin);
        // Closing took ffmpeg away (it was not reading): nothing to restart.
        if child().is_none() {
            return;
        }
        if closed {
            // Let ffmpeg finish its file (HLS), then stop it.
            for _ in 0..20 {
                if let Some(c) = child().as_mut() {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            stop();
            return;
        }
        stop();
        let why = ffmpeg::tail(&log.lock().unwrap_or_else(|p| p.into_inner()));
        tracing::warn!(output = name, "stream stopped: {why}");
        set(Some(why));
        if !wait(&rx, Duration::from_secs(2)) {
            return;
        }
    }
}

/// Throws frames away for `d`; false when the output was closed meanwhile.
fn wait(rx: &Receiver<Arc<Vec<u8>>>, d: Duration) -> bool {
    let until = std::time::Instant::now() + d;
    loop {
        let left = until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return true;
        }
        match rx.recv_timeout(left) {
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => return true,
            Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
}

impl OutputSink for StreamSender {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn push(&mut self, frame: &Arc<Frame>, _at: std::time::SystemTime) -> Result<(), OutputError> {
        if let Some(e) = self.error.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            return Err(OutputError::Unsupported(e));
        }
        let Some(tx) = &self.tx else {
            return Err(OutputError::Closed);
        };
        let buf = match self.last.take() {
            // The same picture again (nothing moved): sent as converted.
            Some((f, b)) if Arc::ptr_eq(&f, frame) => {
                self.last = Some((f, b.clone()));
                b
            }
            last => {
                // A buffer ffmpeg is done with (not the last one, still ours).
                let mut buf = Vec::new();
                while let Ok(b) = self.spare.try_recv() {
                    if let Ok(b) = Arc::try_unwrap(b) {
                        buf = b;
                        break;
                    }
                }
                drop(last);
                let at = buf.as_ptr() as usize;
                let held = self.made.iter().position(|(p, _)| *p == at);
                let from = held.map(|i| self.made.swap_remove(i).1);
                over_background_from(frame, from.as_deref(), self.bg, &mut buf);
                // (An address freed and taken again by a new buffer: its old picture forgotten.)
                let at = buf.as_ptr() as usize;
                self.made.retain(|(p, _)| *p != at);
                self.made.push((at, frame.clone()));
                if self.made.len() > 8 {
                    self.made.remove(0);
                }
                let buf = Arc::new(buf);
                self.last = Some((frame.clone(), buf.clone()));
                buf
            }
        };
        match tx.try_send(buf) {
            Ok(()) => Ok(()),
            // ffmpeg is behind: this frame is skipped.
            Err(TrySendError::Full(_)) => Err(OutputError::Dropped),
            Err(TrySendError::Disconnected(_)) => Err(OutputError::Closed),
        }
    }

    fn process(&self) -> Option<u32> {
        self.child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|c| c.id())
    }
}

impl Drop for StreamSender {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(w) = self.worker.take() {
            // The worker finishes ffmpeg's file in about a second; one stuck
            // writing to an ffmpeg that does not read is stopped.
            for _ in 0..30 {
                if w.is_finished() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if !w.is_finished() {
                let c = self.child.lock().unwrap_or_else(|p| p.into_inner()).take();
                if let Some(mut c) = c {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
            let _ = w.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture with something in every row (premultiplied).
    pub(crate) fn picture(w: u32, h: u32, seed: usize) -> Frame {
        let mut f = Frame::blank(w, h);
        for (i, p) in f.data.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let a = ((i * 37 + seed) % 256) as u8;
            let c = |k: usize| (((i * k + seed) % 256) as u16 * a as u16 / 255) as u8;
            *p = [c(7), c(11), c(13), a];
        }
        f
    }

    #[test]
    fn only_rows_that_changed_are_converted_again() {
        let old = picture(33, 9, 1);
        let mut new = old.clone();
        for b in &mut new.data[33 * 4 * 3..33 * 4 * 5] {
            *b /= 2;
        }
        let mut got = Vec::new();
        over_background(&old, [10, 20, 30], &mut got);
        let mut want = Vec::new();
        over_background(&new, [10, 20, 30], &mut want);
        over_background_from(&new, Some(&old), [10, 20, 30], &mut got);
        assert_eq!(got, want);
        // A buffer of another size, or of no known picture: converted whole.
        let mut other = vec![7; 3];
        over_background_from(&new, Some(&old), [10, 20, 30], &mut other);
        assert_eq!(other, want);
    }

    fn cfg(protocol: Protocol, url: &str) -> StreamConfig {
        StreamConfig {
            id: "s".into(),
            name: "S".into(),
            protocol,
            url: url.into(),
            listen: false,
            bitrate: 6000,
            codec: Codec::H264,
            background: "#000000".into(),
            audio: true,
            hw_encode: false,
            enabled: true,
        }
    }

    #[test]
    fn targets_are_checked() {
        assert_eq!(
            cfg(Protocol::Udp, "udp://239.1.1.1:5000").target().unwrap(),
            "udp://239.1.1.1:5000?pkt_size=1316"
        );
        assert!(cfg(Protocol::Udp, "srt://x:1").target().is_err());
        let mut s = cfg(Protocol::Srt, "srt://0.0.0.0:9000");
        s.listen = true;
        assert_eq!(s.target().unwrap(), "srt://0.0.0.0:9000?mode=listener");
        assert!(cfg(Protocol::Rtmp, "rtmps://live.example/app/key")
            .target()
            .is_ok());
        let a = args(
            &cfg(Protocol::Rtmp, "rtmp://x/app/k"),
            1920,
            1080,
            (50, 1),
            None,
            "libx264",
        )
        .unwrap();
        assert!(a.windows(2).any(|w| w == ["-f", "flv"]) && a.contains(&"100".to_string()));
        assert!(args(&cfg(Protocol::Hls, ""), 1280, 720, (25, 1), None, "libx264").is_err());
        // A Mac's encoder: real time, constant rate, the picture as it takes it.
        let a = args(
            &cfg(Protocol::Srt, "srt://h:1"),
            1920,
            1080,
            (50, 1),
            None,
            "h264_videotoolbox",
        )
        .unwrap();
        let has = |w: [&str; 2]| a.windows(2).any(|x| x == w);
        assert!(
            has(["-c:v", "h264_videotoolbox"])
                && has(["-realtime", "1"])
                && has(["-pix_fmt", "nv12"])
        );
        assert!(has(["-b:v", "6000k"]) && !a.iter().any(|x| x == "zerolatency"));
    }

    #[test]
    fn graphics_over_the_background() {
        let f = Frame {
            width: 3,
            height: 1,
            // Half-transparent red (premultiplied), nothing, opaque grey.
            data: vec![128, 0, 0, 128, 0, 0, 0, 0, 9, 9, 9, 255],
            captured_at: std::time::SystemTime::now(),
        };
        // A used buffer of another size comes back right.
        let mut out = vec![7; 20];
        over_background(&f, [0, 0, 255], &mut out);
        assert_eq!(out, vec![128, 0, 127, 0, 0, 255, 9, 9, 9]);
    }

    /// A listener nobody called does not read its pictures: closing the
    /// output still stops it at once.
    #[test]
    fn an_idle_listener_closes() {
        if ffmpeg::command().arg("-version").output().is_err() {
            return;
        }
        let mut c = cfg(Protocol::Srt, "srt://127.0.0.1:47391");
        c.listen = true;
        let mut s = StreamSender::open(c, 320, 180, (25, 1), None).unwrap();
        let f = Frame {
            width: 320,
            height: 180,
            data: vec![0; 320 * 180 * 4],
            captured_at: std::time::SystemTime::now(),
        };
        let f = Arc::new(f);
        for _ in 0..50 {
            let _ = s.push(&f, std::time::SystemTime::now());
            std::thread::sleep(Duration::from_millis(10));
        }
        let t = std::time::Instant::now();
        drop(s);
        assert!(t.elapsed() < Duration::from_secs(4));
    }
}
