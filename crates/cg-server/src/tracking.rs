//! Camera tracking received over the network: OpenTrackIO (SMPTE RIS
//! OSVP), as the Sony FR7 sends it, in multicast or unicast.
//!
//! A packet is a 16-byte header, then a segment of the payload: "OTrk",
//! a reserved byte, the encoding (1 JSON, 2 CBOR), a sequence number (u16),
//! the segment's offset in the payload (u32), the last-segment bit and the
//! segment's length (u16), and the Fletcher-16 of the first 14 bytes and
//! the segment; big-endian. A camera sends to 239.135.1.<source number>,
//! port 55555, by default.
//!
//! Each tracking input (an input of kind `tracking`) has a receiving
//! thread. Its samples are kept for two seconds, stamped on a steady clock
//! locked to their arrivals (the network delivers them unevenly). A frame
//! takes where the camera looked `delay` frames before the frame is shown,
//! to meet the video it is keyed over: between the two samples around that
//! time, or on from the last at the same pace for a few samples.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use cg_core::tracking::{mix, CameraSample, Distortion};
use serde_json::Value as Json;

use crate::inputs::{InputConfig, InputKind, InputStatus};

/// The port OpenTrackIO sends to by default.
pub const PORT: u16 = 55555;
const HEADER: usize = 16;
/// Samples kept for the delay.
const KEPT: Duration = Duration::from_secs(2);

/// Samples sent to the clients by camera (they interpolate between them).
const SENT: usize = 6;
/// How far past the last sample a camera goes on at the same pace, in samples.
const AHEAD: f64 = 3.0;

/// A sample for the clients: when it is to be shown (server clock, ms since
/// 1970, its delay added) and where the camera looked.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Timed {
    pub t: f64,
    #[serde(flatten)]
    pub s: CameraSample,
}

/// The cameras' last samples, by tracking input, oldest first.
pub type Shown = Arc<BTreeMap<String, Vec<Timed>>>;

/// `t` on the steady clock.
fn instant_of(t: SystemTime) -> Instant {
    let (now, wall) = (Instant::now(), SystemTime::now());
    match t.duration_since(wall) {
        Ok(d) => now + d,
        Err(e) => now.checked_sub(e.duration()).unwrap_or(now),
    }
}

/// `t` on the wall clock, ms since 1970.
fn wall_ms(t: Instant) -> f64 {
    let (now, wall) = (Instant::now(), SystemTime::now());
    let w = if t >= now {
        wall + (t - now)
    } else {
        wall - (now - t)
    };
    w.duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Stamps samples on a steady clock: one period after the last, drawn
/// slowly towards when they arrive (a lost sample skips a period; a long
/// gap starts again from the arrival).
#[derive(Default)]
struct Steady {
    last: Option<Instant>,
}

impl Steady {
    fn stamp(&mut self, arrived: Instant, period: f64) -> Instant {
        let at = match self.last {
            None => arrived,
            Some(last) => {
                let predicted = last + Duration::from_secs_f64(period);
                let err = if arrived >= predicted {
                    (arrived - predicted).as_secs_f64()
                } else {
                    -(predicted - arrived).as_secs_f64()
                };
                let lost = (err / period).round().max(0.0);
                if lost > 4.0 || err < -4.0 * period {
                    arrived
                } else {
                    let err = err - lost * period;
                    let at = predicted + Duration::from_secs_f64(lost * period);
                    if err >= 0.0 {
                        at + Duration::from_secs_f64(err * 0.1)
                    } else {
                        at - Duration::from_secs_f64(-err * 0.1)
                    }
                }
            }
        };
        self.last = Some(at);
        at
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The tracking inputs that run.
pub struct Tracking {
    running: Mutex<HashMap<String, Receiver>>,
    shown: tokio::sync::watch::Sender<Shown>,
}

impl Default for Tracking {
    fn default() -> Self {
        Self {
            running: Default::default(),
            shown: tokio::sync::watch::channel(Shown::default()).0,
        }
    }
}

struct Receiver {
    config: InputConfig,
    iface: Option<Ipv4Addr>,
    cam: Arc<Cam>,
}

/// One camera: what its thread received.
struct Cam {
    id: String,
    /// Frames late (at the camera's rate).
    delay: u32,
    /// Late on top of that, µs: the camera delayed at the mixer while its
    /// people are found (`crate::people`).
    extra: AtomicU64,
    source: u8,
    stop: AtomicBool,
    samples: Mutex<VecDeque<(Instant, CameraSample)>>,
    /// Samples a second, as the camera says.
    rate: Mutex<Option<f64>>,
    received: AtomicU64,
    message: Mutex<String>,
    /// The sensor's width, sent from time to time (the static block).
    sensor: Mutex<f64>,
}

impl Cam {
    fn say(&self, m: impl Into<String>) {
        *lock(&self.message) = m.into();
    }

    fn live(&self) -> bool {
        lock(&self.samples)
            .back()
            .is_some_and(|(t, _)| t.elapsed() < Duration::from_secs(2))
    }

    /// Seconds between two samples.
    fn period(&self) -> f64 {
        1.0 / lock(&self.rate).unwrap_or(50.0).max(1.0)
    }

    /// The delay, as a duration.
    fn late(&self) -> Duration {
        Duration::from_secs_f64(self.delay as f64 * self.period())
            + Duration::from_micros(self.extra.load(Ordering::Relaxed))
    }

    /// Where the camera looked `delay` frames before `t`: between the two
    /// samples around then, on from the last at the same pace a little
    /// while, the oldest kept before them all.
    fn at(&self, t: Instant) -> Option<CameraSample> {
        let samples = lock(&self.samples);
        let due = t.checked_sub(self.late())?;
        let after = samples.iter().position(|(at, _)| *at > due);
        let (a, b) = match after {
            Some(0) => return samples.front().map(|(_, s)| *s),
            Some(i) => (samples[i - 1], samples[i]),
            None if samples.len() >= 2 => (samples[samples.len() - 2], samples[samples.len() - 1]),
            None => return samples.back().map(|(_, s)| *s),
        };
        let span = (b.0 - a.0).as_secs_f64();
        if span <= 0.0 {
            return Some(b.1);
        }
        let k = if due >= a.0 {
            (due - a.0).as_secs_f64() / span
        } else {
            0.0
        };
        Some(mix(&a.1, &b.1, k.min(1.0 + AHEAD * self.period() / span)))
    }

    /// The last samples for the clients.
    fn sent(&self) -> Vec<Timed> {
        let late = self.late();
        let samples = lock(&self.samples);
        samples
            .iter()
            .skip(samples.len().saturating_sub(SENT))
            .map(|(at, s)| Timed {
                t: wall_ms(*at + late),
                s: *s,
            })
            .collect()
    }
}

impl Tracking {
    /// Runs the tracking inputs: new and changed ones start, removed ones stop.
    /// `iface`: the network card of the Tracking role (multicast joined on it).
    pub fn apply(&self, inputs: &[InputConfig], iface: Option<Ipv4Addr>) {
        let configs: Vec<&InputConfig> = inputs
            .iter()
            .filter(|c| c.enabled && c.kind == InputKind::Tracking && !c.id.is_empty())
            .collect();
        let mut running = lock(&self.running);
        running.retain(|id, r| {
            let keep = configs
                .iter()
                .any(|c| &c.id == id && **c == r.config && r.iface == iface);
            if !keep {
                r.cam.stop.store(true, Ordering::Relaxed);
            }
            keep
        });
        for c in configs {
            if running.contains_key(&c.id) {
                continue;
            }
            let cam = Arc::new(Cam {
                id: c.id.clone(),
                delay: c.delay,
                extra: AtomicU64::new(0),
                source: c.source,
                stop: AtomicBool::new(false),
                samples: Default::default(),
                rate: Default::default(),
                received: AtomicU64::new(0),
                message: Mutex::new("Starting…".into()),
                sensor: Mutex::new(0.0),
            });
            let (config, shown, thread_cam) = (c.clone(), self.shown.clone(), cam.clone());
            let spawned = std::thread::Builder::new()
                .name(format!("cg-tracking-{}", c.id))
                .spawn(move || receive(&thread_cam, &config, iface, &shown));
            if let Err(e) = spawned {
                cam.say(format!("cannot start: {e}"));
            }
            running.insert(
                c.id.clone(),
                Receiver {
                    config: c.clone(),
                    iface,
                    cam,
                },
            );
        }
        // The cameras no longer received are no longer shown.
        let ids: Vec<String> = running.keys().cloned().collect();
        self.shown.send_if_modified(|m| {
            let before = m.len();
            Arc::make_mut(m).retain(|id, _| ids.contains(id));
            m.len() != before
        });
    }

    /// Camera `id` is late `late` more (its picture delayed at the mixer).
    pub fn set_extra(&self, id: &str, late: Duration) {
        if let Some(r) = lock(&self.running).get(id) {
            r.cam
                .extra
                .store(late.as_micros() as u64, Ordering::Relaxed);
        }
    }

    /// Where camera `id` looks for graphics shown now (late by its delay).
    #[cfg(test)]
    pub fn sample(&self, id: &str) -> Option<CameraSample> {
        lock(&self.running).get(id)?.cam.at(Instant::now())
    }

    /// The cameras the templates of a project follow, for a frame shown at `shown`.
    pub fn for_project(
        &self,
        p: &cg_core::Project,
        shown: SystemTime,
    ) -> BTreeMap<String, CameraSample> {
        let at = instant_of(shown);
        let running = lock(&self.running);
        let mut out = BTreeMap::new();
        for t in &p.templates {
            if let Some(id) = &t.camera {
                if !out.contains_key(id) {
                    if let Some(s) = running.get(id).and_then(|r| r.cam.at(at)) {
                        out.insert(id.clone(), s);
                    }
                }
            }
        }
        out
    }

    /// Every camera as it is shown, for the clients (the HTML5 outputs, the Designer).
    pub fn watch(&self) -> tokio::sync::watch::Receiver<Shown> {
        self.shown.subscribe()
    }

    /// The running cameras' latest samples (late by their delay), by input.
    pub fn latest(&self) -> Vec<(String, CameraSample)> {
        lock(&self.running)
            .iter()
            .filter(|(_, r)| r.cam.live())
            .filter_map(|(id, r)| r.cam.at(Instant::now()).map(|s| (id.clone(), s)))
            .collect()
    }

    pub fn status(&self) -> Vec<InputStatus> {
        lock(&self.running)
            .values()
            .map(|r| InputStatus {
                id: r.cam.id.clone(),
                live: r.cam.live(),
                message: lock(&r.cam.message).clone(),
                frames: r.cam.received.load(Ordering::Relaxed),
                fps: *lock(&r.cam.rate),
                ..Default::default()
            })
            .collect()
    }

    pub fn stop(&self) {
        for r in lock(&self.running).values() {
            r.cam.stop.store(true, Ordering::Relaxed);
        }
    }
}

impl Drop for Tracking {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The multicast group of a source number.
pub fn group(source: u8) -> Ipv4Addr {
    Ipv4Addr::new(239, 135, 1, source)
}

fn open(c: &InputConfig, iface: Option<Ipv4Addr>) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let port = if c.port == 0 { PORT } else { c.port };
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // Several cameras on the same port, each in its group.
    s.set_reuse_address(true)?;
    #[cfg(unix)]
    s.set_reuse_port(true)?;
    s.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into())?;
    if c.multicast {
        s.join_multicast_v4(&group(c.source), &iface.unwrap_or(Ipv4Addr::UNSPECIFIED))?;
    }
    s.set_read_timeout(Some(Duration::from_millis(200)))?;
    Ok(s.into())
}

/// The receiving thread of a camera.
fn receive(
    cam: &Cam,
    c: &InputConfig,
    iface: Option<Ipv4Addr>,
    shown: &tokio::sync::watch::Sender<Shown>,
) {
    let sock = match open(c, iface) {
        Ok(s) => s,
        Err(e) => {
            cam.say(format!("Cannot listen: {e}"));
            return;
        }
    };
    cam.say("Waiting for the camera…");
    let mut buf = vec![0u8; 65_536];
    let mut parts = Segments::default();
    let mut steady = Steady::default();
    while !cam.stop.load(Ordering::Relaxed) {
        match sock.recv(&mut buf) {
            Ok(n) => {
                let Some((encoding, payload)) = parts.push(&buf[..n]) else {
                    continue;
                };
                let value = match encoding {
                    1 => serde_json::from_slice(&payload).map_err(|e| e.to_string()),
                    2 => cbor(&payload),
                    e => Err(format!("unknown encoding {e}")),
                };
                let v = match value {
                    Ok(v) => v,
                    Err(e) => {
                        cam.say(format!("Unreadable sample: {e}"));
                        continue;
                    }
                };
                // Another camera in the same group or on the same port.
                if v.get("sourceNumber")
                    .and_then(Json::as_u64)
                    .is_some_and(|n| n != u64::from(cam.source))
                {
                    continue;
                }
                if let Some(w) = sensor_of(&v) {
                    *lock(&cam.sensor) = w;
                }
                let Some(mut s) = sample_of(&v) else {
                    continue;
                };
                if s.sensor == 0.0 {
                    s.sensor = *lock(&cam.sensor);
                }
                s.sensor_sent = s.sensor > 0.0;
                // The input's settings: a sensor mode the camera does not
                // say, the optical centre when it does not send it.
                if c.sensor > 0.0 {
                    s.sensor = c.sensor;
                }
                if !s.pupil_sent {
                    s.pupil = c.pupil;
                }
                if let Some(r) = rate_of(&v) {
                    *lock(&cam.rate) = Some(r);
                }
                let now = Instant::now();
                let at = steady.stamp(now, cam.period());
                {
                    let mut kept = lock(&cam.samples);
                    kept.push_back((at, s));
                    while kept
                        .front()
                        .is_some_and(|(t, _)| now.saturating_duration_since(*t) > KEPT)
                    {
                        kept.pop_front();
                    }
                }
                if cam.received.fetch_add(1, Ordering::Relaxed) == 0 {
                    cam.say("Receiving");
                }
                // To the clients: each sample, with the ones before it.
                let sent = cam.sent();
                shown.send_modify(|m| {
                    Arc::make_mut(m).insert(cam.id.clone(), sent);
                });
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => {
                cam.say(format!("Cannot receive: {e}"));
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

// ------------------------------------------------------------- packets --

/// The Fletcher-16 of OpenTrackIO (its sums modulo 256, as the reference code).
fn fletcher16(parts: &[&[u8]]) -> u16 {
    let (mut a, mut b) = (0u8, 0u8);
    for p in parts {
        for &x in *p {
            a = a.wrapping_add(x);
            b = b.wrapping_add(a);
        }
    }
    (u16::from(b) << 8) | u16::from(a)
}

/// A payload put together from its segments.
#[derive(Default)]
struct Segments {
    payload: Vec<u8>,
}

impl Segments {
    /// Takes a packet; the encoding and the payload once its last segment came.
    fn push(&mut self, p: &[u8]) -> Option<(u8, Vec<u8>)> {
        if p.len() < HEADER || &p[..4] != b"OTrk" {
            return None;
        }
        let offset = u32::from_be_bytes([p[8], p[9], p[10], p[11]]) as usize;
        let lw = u16::from_be_bytes([p[12], p[13]]);
        let last = lw & 0x8000 != 0;
        let len = usize::from(lw & 0x7fff);
        let seg = p.get(HEADER..HEADER + len)?;
        if fletcher16(&[&p[..14], seg]) != u16::from_be_bytes([p[14], p[15]]) {
            return None;
        }
        if offset == 0 {
            self.payload.clear();
        } else if offset != self.payload.len() {
            // A segment lost: this payload is.
            self.payload.clear();
            return None;
        }
        self.payload.extend_from_slice(seg);
        last.then(|| (p[5], std::mem::take(&mut self.payload)))
    }
}

// ---------------------------------------------------------------- CBOR --

/// A CBOR payload as JSON (what OpenTrackIO samples use: maps, arrays,
/// texts, numbers, booleans).
pub fn cbor(b: &[u8]) -> Result<Json, String> {
    let mut at = 0;
    let v = item(b, &mut at, 0)?;
    Ok(v)
}

fn take<'a>(b: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8], String> {
    let s = b.get(*at..*at + n).ok_or("truncated")?;
    *at += n;
    Ok(s)
}

/// The argument of a head (`None`: indefinite length).
fn argument(b: &[u8], at: &mut usize, info: u8) -> Result<Option<u64>, String> {
    Ok(Some(match info {
        0..=23 => u64::from(info),
        24 => u64::from(take(b, at, 1)?[0]),
        25 => u64::from(u16::from_be_bytes(
            take(b, at, 2)?.try_into().unwrap_or_default(),
        )),
        26 => u64::from(u32::from_be_bytes(
            take(b, at, 4)?.try_into().unwrap_or_default(),
        )),
        27 => u64::from_be_bytes(take(b, at, 8)?.try_into().unwrap_or_default()),
        31 => return Ok(None),
        _ => return Err("bad length".into()),
    }))
}

fn half(h: u16) -> f64 {
    let exp = (h >> 10) & 0x1f;
    let mant = f64::from(h & 0x3ff);
    let v = match exp {
        0 => mant * 2f64.powi(-24),
        31 => {
            if mant == 0.0 {
                f64::INFINITY
            } else {
                f64::NAN
            }
        }
        e => (1.0 + mant / 1024.0) * 2f64.powi(i32::from(e) - 15),
    };
    if h & 0x8000 != 0 {
        -v
    } else {
        v
    }
}

fn item(b: &[u8], at: &mut usize, depth: u32) -> Result<Json, String> {
    if depth > 64 {
        return Err("too deep".into());
    }
    let head = take(b, at, 1)?[0];
    let (major, info) = (head >> 5, head & 0x1f);
    let num = |v: f64| serde_json::Number::from_f64(v).map_or(Json::Null, Json::Number);
    match major {
        0 => Ok(Json::from(argument(b, at, info)?.ok_or("bad integer")?)),
        1 => {
            let n = argument(b, at, info)?.ok_or("bad integer")?;
            Ok(i64::try_from(n).map_or_else(|_| num(-1.0 - n as f64), |n| Json::from(-1 - n)))
        }
        2 | 3 => {
            let mut bytes = Vec::new();
            match argument(b, at, info)? {
                Some(n) => bytes.extend_from_slice(take(b, at, n as usize)?),
                // Chunks up to a break.
                None => loop {
                    if b.get(*at) == Some(&0xff) {
                        *at += 1;
                        break;
                    }
                    let h = take(b, at, 1)?[0];
                    let n = argument(b, at, h & 0x1f)?.ok_or("bad chunk")?;
                    bytes.extend_from_slice(take(b, at, n as usize)?);
                },
            }
            Ok(Json::String(String::from_utf8_lossy(&bytes).into_owned()))
        }
        4 => {
            let mut a = Vec::new();
            match argument(b, at, info)? {
                Some(n) => {
                    for _ in 0..n {
                        a.push(item(b, at, depth + 1)?);
                    }
                }
                None => loop {
                    if b.get(*at) == Some(&0xff) {
                        *at += 1;
                        break;
                    }
                    a.push(item(b, at, depth + 1)?);
                },
            }
            Ok(Json::Array(a))
        }
        5 => {
            let mut m = serde_json::Map::new();
            let mut pair = |at: &mut usize| -> Result<(), String> {
                let k = match item(b, at, depth + 1)? {
                    Json::String(s) => s,
                    other => other.to_string(),
                };
                m.insert(k, item(b, at, depth + 1)?);
                Ok(())
            };
            match argument(b, at, info)? {
                Some(n) => {
                    for _ in 0..n {
                        pair(at)?;
                    }
                }
                None => loop {
                    if b.get(*at) == Some(&0xff) {
                        *at += 1;
                        break;
                    }
                    pair(at)?;
                },
            }
            Ok(Json::Object(m))
        }
        // A tag: its item.
        6 => {
            argument(b, at, info)?;
            item(b, at, depth + 1)
        }
        _ => match info {
            20 => Ok(Json::Bool(false)),
            21 => Ok(Json::Bool(true)),
            22 | 23 => Ok(Json::Null),
            25 => Ok(num(half(u16::from_be_bytes(
                take(b, at, 2)?.try_into().unwrap_or_default(),
            )))),
            26 => Ok(num(f64::from(f32::from_be_bytes(
                take(b, at, 4)?.try_into().unwrap_or_default(),
            )))),
            27 => Ok(num(f64::from_be_bytes(
                take(b, at, 8)?.try_into().unwrap_or_default(),
            ))),
            _ => Err("unknown simple value".into()),
        },
    }
}

// ------------------------------------------------------------- samples --

fn f(v: &Json, path: &[&str]) -> Option<f64> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_f64()
}

/// The camera's pose and lens in a sample: the transform named like the
/// camera ("Camera"), else the last one.
fn sample_of(v: &Json) -> Option<CameraSample> {
    let transforms = v.get("transforms")?.as_array()?;
    let t = transforms
        .iter()
        .rev()
        .find(|t| {
            t.get("id")
                .and_then(Json::as_str)
                .is_some_and(|id| id.to_ascii_lowercase().contains("camera"))
        })
        .or(transforms.last())?;
    let r = |k: &str| f(t, &["rotation", k]).unwrap_or(0.0);
    let p = |k: &str| f(t, &["translation", k]).unwrap_or(0.0);
    let lens = |k: &str| f(v, &["lens", k]).unwrap_or(0.0);
    t.get("rotation")?;
    let pupil = f(v, &["lens", "entrancePupilOffset"]);
    Some(CameraSample {
        pan: r("pan"),
        tilt: r("tilt"),
        roll: r("roll"),
        focal: lens("pinholeFocalLength"),
        sensor: sensor_of(v).unwrap_or(0.0),
        focus: lens("focusDistance"),
        iris: lens("fStop"),
        x: p("x"),
        y: p("y"),
        z: p("z"),
        distortion: distortion_of(v),
        pupil: pupil.unwrap_or(0.0),
        pupil_sent: pupil.is_some(),
        sensor_sent: false,
    })
}

/// The lens distortion of a sample (OpenTrackIO's `lens.distortion`: one
/// Brown-Conrady model, or a list of them, the first kept). Its model says
/// which way it goes ("D-U" when it says none).
fn distortion_of(v: &Json) -> Option<Distortion> {
    let d = v.get("lens")?.get("distortion")?;
    let d = d.as_array().map_or(Some(d), |l| l.first())?;
    let at = |key: &str, i: usize| {
        d.get(key)
            .and_then(Json::as_array)
            .and_then(|a| a.get(i))
            .and_then(Json::as_f64)
            .unwrap_or(0.0)
    };
    let out = Distortion {
        k1: at("radial", 0),
        k2: at("radial", 1),
        k3: at("radial", 2),
        p1: at("tangential", 0),
        p2: at("tangential", 1),
        to_undistorted: !d
            .get("model")
            .and_then(Json::as_str)
            .is_some_and(|m| m.to_ascii_uppercase().contains("U-D")),
    };
    (out != Distortion {
        to_undistorted: out.to_undistorted,
        ..Default::default()
    })
    .then_some(out)
}

/// The width of the sensor's active area (mm), when the sample has its static block.
fn sensor_of(v: &Json) -> Option<f64> {
    let s = [
        "static",
        "camera",
        "activeSensorPhysicalDimensions",
        "width",
    ];
    f(v, &s).or_else(|| f(v, &s[1..])).filter(|w| *w > 0.0)
}

fn rate_of(v: &Json) -> Option<f64> {
    let num = f(v, &["timing", "sampleRate", "num"])?;
    let den = f(v, &["timing", "sampleRate", "denom"]).unwrap_or(1.0);
    (num > 0.0 && den > 0.0).then(|| num / den)
}

/// A camera's values as a data source shows them (B: the tracking as data).
pub fn as_data(s: &CameraSample) -> Json {
    let r = |v: f64, d: i32| {
        let k = 10f64.powi(d);
        (v * k).round() / k
    };
    serde_json::json!({
        "pan": r(s.pan, 2),
        "tilt": r(s.tilt, 2),
        "roll": r(s.roll, 2),
        "focal": r(s.focal, 1),
        "focus": r(s.focus, 2),
        "iris": r(s.iris, 1),
        "x": r(s.x, 3),
        "y": r(s.y, 3),
        "z": r(s.z, 3),
    })
}

/// The data source of a tracking input.
pub fn source_id(input: &str) -> String {
    format!("camera-{input}")
}

/// Puts the cameras' values in their data sources, five times a second
/// (one engine cycle).
pub async fn to_data(shared: crate::state::Shared) {
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        for (id, s) in shared.tracking.latest() {
            let source = source_id(&id);
            if shared.data.live(&source, as_data(&s)) {
                crate::datasources::updated(&shared, &source, true).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An OpenTrackIO packet of one segment.
    fn packet(encoding: u8, payload: &[u8]) -> Vec<u8> {
        segment(encoding, 0, 0, payload, true)
    }

    fn segment(encoding: u8, seq: u16, offset: u32, payload: &[u8], last: bool) -> Vec<u8> {
        let mut p = b"OTrk".to_vec();
        p.push(0);
        p.push(encoding);
        p.extend_from_slice(&seq.to_be_bytes());
        p.extend_from_slice(&offset.to_be_bytes());
        p.extend_from_slice(&(u16::from(last) << 15 | payload.len() as u16).to_be_bytes());
        let sum = fletcher16(&[&p[..14], payload]);
        p.extend_from_slice(&sum.to_be_bytes());
        p.extend_from_slice(payload);
        p
    }

    const SAMPLE: &str = r#"{"protocol":{"name":"OpenTrackIO","version":[1,0,1]},"sourceNumber":1,
        "timing":{"sampleRate":{"num":50,"denom":1}},
        "lens":{"pinholeFocalLength":24.5,"focusDistance":4.2,"fStop":2.8},
        "transforms":[{"id":"Camera","translation":{"x":1.0,"y":2.0,"z":1.5},"rotation":{"pan":12.5,"tilt":-3.0,"roll":0.0}}],
        "static":{"camera":{"activeSensorPhysicalDimensions":{"width":35.6,"height":20.0}}}}"#;

    #[test]
    fn the_checksum_is_fletcher16() {
        // The reference sender's algorithm: sums modulo 256.
        assert_eq!(fletcher16(&[b"abcde"]), 0xC3EF);
        assert_eq!(fletcher16(&[b"ab", b"cde"]), 0xC3EF);
    }

    #[test]
    fn a_json_packet_gives_its_sample() {
        let mut parts = Segments::default();
        let (enc, payload) = parts.push(&packet(1, SAMPLE.as_bytes())).unwrap();
        assert_eq!(enc, 1);
        let v: Json = serde_json::from_slice(&payload).unwrap();
        let s = sample_of(&v).unwrap();
        assert_eq!((s.pan, s.tilt, s.focal, s.sensor), (12.5, -3.0, 24.5, 35.6));
        assert_eq!((s.focus, s.iris, s.z), (4.2, 2.8, 1.5));
        assert_eq!(rate_of(&v), Some(50.0));
        // No lens model sent.
        assert!(s.distortion.is_none() && !s.pupil_sent);
    }

    #[test]
    fn the_lens_model_is_read() {
        let v = serde_json::json!({
            "transforms": [{"id": "Camera", "rotation": {"pan": 0, "tilt": 0, "roll": 0}}],
            "lens": {"entrancePupilOffset": 0.118,
                     "distortion": [{"model": "Brown-Conrady U-D", "radial": [-0.05, 0.01], "tangential": [0.001, 0.0]}]}
        });
        let s = sample_of(&v).unwrap();
        assert!(s.pupil_sent && (s.pupil - 0.118).abs() < 1e-12);
        let d = s.distortion.unwrap();
        assert_eq!((d.k1, d.k2, d.k3, d.p1), (-0.05, 0.01, 0.0, 0.001));
        assert!(!d.to_undistorted);
        // One model, no direction said: distorted to undistorted.
        let v = serde_json::json!({
            "transforms": [{"rotation": {"pan": 0}}],
            "lens": {"distortion": {"radial": [0.02]}}
        });
        assert!(sample_of(&v).unwrap().distortion.unwrap().to_undistorted);
        // All zero: none.
        let v = serde_json::json!({
            "transforms": [{"rotation": {"pan": 0}}],
            "lens": {"distortion": [{"radial": [0, 0, 0]}]}
        });
        assert!(sample_of(&v).unwrap().distortion.is_none());
    }

    #[test]
    fn segments_make_one_payload_and_a_bad_one_is_dropped() {
        let b = SAMPLE.as_bytes();
        let mut parts = Segments::default();
        assert!(parts.push(&segment(1, 7, 0, &b[..100], false)).is_none());
        let (_, all) = parts.push(&segment(1, 8, 100, &b[100..], true)).unwrap();
        assert_eq!(all, b);
        // A corrupted packet, a missing segment: nothing.
        let mut bad = packet(1, b);
        let n = bad.len();
        bad[n - 3] ^= 1;
        assert!(parts.push(&bad).is_none());
        assert!(parts.push(&segment(1, 9, 100, &b[100..], true)).is_none());
        assert!(parts.push(b"OTrk").is_none());
    }

    #[test]
    fn cbor_reads_what_samples_hold() {
        // {"a": 1, "b": [-2, 1.5, true, null], "c": "été", "d": {"e": 0.5 (half)}}
        let b = [
            0xa4, 0x61, b'a', 0x01, 0x61, b'b', 0x84, 0x21, 0xfb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0,
            0xf5, 0xf6, 0x61, b'c', 0x64, 0x63, 0xc3, 0xa9, 0x74, 0x61, b'd', 0xa1, 0x61, b'e',
            0xf9, 0x38, 0x00,
        ];
        let v = cbor(&b[..b.len() - 3]).err();
        assert!(v.is_some(), "a truncated payload is an error");
        let mut b = b.to_vec();
        // "c": "été" is 0x65 + 5 bytes.
        b[21] = 0x65;
        b.splice(22..26, [0xc3, 0xa9, b't', 0xc3, 0xa9]);
        let v = cbor(&b).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"a": 1, "b": [-2, 1.5, true, null], "c": "été", "d": {"e": 0.5}})
        );
        // Indefinite lengths.
        let v = cbor(&[0xbf, 0x61, b'x', 0x9f, 0x01, 0x02, 0xff, 0xff]).unwrap();
        assert_eq!(v, serde_json::json!({"x": [1, 2]}));
    }

    fn cam(delay: u32) -> Cam {
        Cam {
            id: "c".into(),
            delay,
            extra: AtomicU64::new(0),
            source: 1,
            stop: AtomicBool::new(false),
            samples: Default::default(),
            rate: Mutex::new(Some(50.0)),
            received: AtomicU64::new(0),
            message: Default::default(),
            sensor: Mutex::new(0.0),
        }
    }

    fn pan(p: f64) -> CameraSample {
        CameraSample {
            pan: p,
            focal: 35.0,
            ..Default::default()
        }
    }

    #[test]
    fn uneven_arrivals_are_stamped_evenly() {
        let t0 = Instant::now();
        let mut steady = Steady::default();
        // 50 a second, each arriving up to 6 ms late, one lost.
        let jitter = [0, 6, 1, 5, 0, 3, 6, 2, 0, 4];
        let mut stamps = Vec::new();
        for (i, j) in (0..40u64).zip(jitter.iter().cycle()) {
            if i == 20 {
                continue;
            }
            let arrived = t0 + Duration::from_millis(i * 20 + j);
            stamps.push((i, steady.stamp(arrived, 0.02)));
        }
        // Once locked: one period apart (two over the lost one), within 1 ms.
        for w in stamps[10..].windows(2) {
            let ((i, a), (k, b)) = (w[0], w[1]);
            let gap = (b - a).as_secs_f64() * 1000.0;
            assert!(
                (gap - 20.0 * (k - i) as f64).abs() < 1.0,
                "{gap} ms between {i} and {k}"
            );
        }
    }

    #[test]
    fn a_frame_takes_the_camera_between_samples() {
        let c = cam(0);
        let t0 = Instant::now();
        lock(&c.samples).extend([(t0, pan(0.0)), (t0 + Duration::from_millis(20), pan(2.0))]);
        let at = |ms: u64| c.at(t0 + Duration::from_millis(ms)).unwrap().pan;
        assert!((at(10) - 1.0).abs() < 1e-9);
        // On at the same pace a little past the last sample, then held.
        assert!((at(30) - 3.0).abs() < 1e-9);
        assert!((at(500) - 8.0).abs() < 1e-9);
        // Before them all: the oldest.
        assert_eq!(c.at(t0).unwrap().pan, 0.0);
        // Late by its delay: two frames before.
        let late = cam(2);
        lock(&late.samples).extend([(t0, pan(0.0)), (t0 + Duration::from_millis(20), pan(2.0))]);
        assert!((late.at(t0 + Duration::from_millis(50)).unwrap().pan - 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_camera_is_received_and_delayed() {
        let port = {
            let s = UdpSocket::bind("127.0.0.1:0").unwrap();
            s.local_addr().unwrap().port()
        };
        let t = Tracking::default();
        let input = InputConfig {
            id: "fr7".into(),
            kind: InputKind::Tracking,
            port,
            multicast: false,
            source: 1,
            delay: 0,
            ..serde_json::from_str(r#"{"name":"FR7"}"#).unwrap()
        };
        t.apply(std::slice::from_ref(&input), None);
        let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
        let mut rx = t.watch();
        let other = SAMPLE
            .replace("\"sourceNumber\":1", "\"sourceNumber\":2")
            .replace("12.5", "99.0");
        for _ in 0..50 {
            // Another camera on the port: not this one's.
            tx.send_to(&packet(1, other.as_bytes()), ("127.0.0.1", port))
                .unwrap();
            tx.send_to(&packet(1, SAMPLE.as_bytes()), ("127.0.0.1", port))
                .unwrap();
            std::thread::sleep(Duration::from_millis(20));
            // Received, and passed on to the clients.
            if t.sample("fr7").is_some() && rx.has_changed().unwrap_or(false) {
                break;
            }
        }
        let s = t.sample("fr7").expect("a sample");
        assert_eq!(s.pan, 12.5);
        assert!(t.status()[0].live);
        assert!(rx.has_changed().unwrap_or(false));
        assert_eq!(
            rx.borrow_and_update()
                .get("fr7")
                .and_then(|l| l.last())
                .map(|x| x.s.pan),
            Some(12.5)
        );
        // Removed: stopped, no longer shown.
        t.apply(&[], None);
        assert!(t.sample("fr7").is_none());
        assert!(t.watch().borrow().is_empty());
    }
}
