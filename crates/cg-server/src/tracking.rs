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
//! thread. Its samples are kept for two seconds: the graphics take them
//! `delay` frames late, to meet the video they are keyed over.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cg_core::tracking::CameraSample;
use serde_json::Value as Json;

use crate::inputs::{InputConfig, InputKind, InputStatus};

/// The port OpenTrackIO sends to by default.
pub const PORT: u16 = 55555;
const HEADER: usize = 16;
/// Samples kept for the delay.
const KEPT: Duration = Duration::from_secs(2);

/// Where the cameras look, by tracking input (the latest of each, late by its delay).
pub type Shown = Arc<BTreeMap<String, CameraSample>>;

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

    /// The sample `delay` frames before now (the oldest kept when none is that old).
    fn delayed(&self) -> Option<CameraSample> {
        let samples = lock(&self.samples);
        let fps = lock(&self.rate).unwrap_or(50.0).max(1.0);
        let late = Duration::from_secs_f64(self.delay as f64 / fps);
        let due = Instant::now().checked_sub(late)?;
        samples
            .iter()
            .rev()
            .find(|(t, _)| *t <= due)
            .or(samples.front())
            .map(|(_, s)| *s)
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

    /// Where camera `id` looks for the graphics (late by its delay).
    pub fn sample(&self, id: &str) -> Option<CameraSample> {
        lock(&self.running).get(id)?.cam.delayed()
    }

    /// The cameras the templates of a project follow, for a frame.
    pub fn for_project(&self, p: &cg_core::Project) -> BTreeMap<String, CameraSample> {
        let mut out = BTreeMap::new();
        for t in &p.templates {
            if let Some(id) = &t.camera {
                if !out.contains_key(id) {
                    if let Some(s) = self.sample(id) {
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
            .filter_map(|(id, r)| r.cam.delayed().map(|s| (id.clone(), s)))
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
    let mut published = Instant::now();
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
                if let Some(r) = rate_of(&v) {
                    *lock(&cam.rate) = Some(r);
                }
                let now = Instant::now();
                {
                    let mut kept = lock(&cam.samples);
                    kept.push_back((now, s));
                    while kept.front().is_some_and(|(t, _)| now - *t > KEPT) {
                        kept.pop_front();
                    }
                }
                if cam.received.fetch_add(1, Ordering::Relaxed) == 0 {
                    cam.say("Receiving");
                }
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
        // To the clients, at most fifty times a second.
        if published.elapsed() >= Duration::from_millis(20) {
            published = Instant::now();
            if let Some(s) = cam.delayed() {
                shown.send_if_modified(|m| {
                    if m.get(&cam.id) == Some(&s) {
                        return false;
                    }
                    Arc::make_mut(m).insert(cam.id.clone(), s);
                    true
                });
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
    })
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
            // Received, and passed on to the clients (at most every 20 ms).
            if t.sample("fr7").is_some() && rx.has_changed().unwrap_or(false) {
                break;
            }
        }
        let s = t.sample("fr7").expect("a sample");
        assert_eq!(s.pan, 12.5);
        assert!(t.status()[0].live);
        assert!(rx.has_changed().unwrap_or(false));
        assert_eq!(rx.borrow_and_update().get("fr7").map(|s| s.pan), Some(12.5));
        // Removed: stopped, no longer shown.
        t.apply(&[], None);
        assert!(t.sample("fr7").is_none());
        assert!(t.watch().borrow().is_empty());
    }
}
