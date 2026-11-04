//! Sound: the sounds a Logic plays, mixed per audio output and sent as
//! AES67 / SMPTE ST 2110-30 (RTP, L24, 48 kHz, 1 ms packets) or to a sound
//! card of the machine (Dante Virtual Soundcard, an audio interface…).
//!
//! - Sounds are decoded once to 48 kHz stereo (see [`decode`]) and shared.
//! - Each output has its [`Mixer`]: the sounds playing on it, mixed when the
//!   output asks for samples (each with its volume and its fade).
//! - The AES67 sender stamps its packets with the media clock of ST 2110-10
//!   (48 kHz since the epoch, TAI): the host must follow the facility PTP,
//!   as for the ST 2110 video senders. It announces its stream with SAP, as
//!   Dante devices (AES67 mode) and most AES67 receivers expect.

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};

use crate::OutputError;

/// Samples per second, everywhere.
pub const RATE: u32 = 48_000;
/// Stereo.
pub const CHANNELS: usize = 2;
/// Samples (per channel) in one 1 ms AES67 packet.
const PACKET: usize = 48;
/// SAP: where announcements go (RFC 2974, global scope), and how often.
const SAP_GROUP: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 255), 9875);
const SAP_EVERY: Duration = Duration::from_secs(30);

/// A sound decoded: interleaved stereo samples at [`RATE`].
#[derive(Debug, Default)]
pub struct Pcm {
    pub samples: Vec<f32>,
}

impl Pcm {
    pub fn frames(&self) -> usize {
        self.samples.len() / CHANNELS
    }
}

/// The sound of a file is mono (ffmpeg tells it reading the file).
fn is_mono(path: &Path) -> bool {
    let Ok(out) = crate::ffmpeg::command()
        .args(["-loglevel", "info", "-i"])
        .arg(path)
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .find(|l| l.contains("Audio:"))
        .is_some_and(mono_stream)
}

/// An ffmpeg stream line of one channel ("…, 44100 Hz, mono, …").
fn mono_stream(line: &str) -> bool {
    line.split(',')
        .any(|p| matches!(p.trim(), "mono" | "1 channels"))
}

/// Decodes an audio (or video) file to 48 kHz stereo with ffmpeg. A mono
/// sound plays at its level on both channels (ffmpeg would lower it by 3 dB).
pub fn decode(path: &Path) -> Result<Pcm, OutputError> {
    let stereo = if is_mono(path) {
        "pan=stereo|c0=c0|c1=c0"
    } else {
        "anull"
    };
    let out = crate::ffmpeg::command()
        .arg("-i")
        .arg(path)
        .args([
            "-vn", "-af", stereo, "-ac", "2", "-ar", "48000", "-f", "f32le", "-",
        ])
        .output()
        .map_err(|e| OutputError::Message(format!("ffmpeg: {e}")))?;
    if !out.status.success() {
        return Err(OutputError::Message(crate::ffmpeg::tail(
            &String::from_utf8_lossy(&out.stderr),
        )));
    }
    let samples = out
        .stdout
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    Ok(Pcm { samples })
}

/// dB → gain.
pub fn gain_of(db: f64) -> f32 {
    if db <= -90.0 {
        0.0
    } else {
        10f64.powf(db / 20.0) as f32
    }
}

/// A sound playing on an output.
struct Voice {
    /// What it plays (the sound's address): what « Stop a sound » names.
    key: String,
    pcm: Arc<Pcm>,
    /// Next frame.
    pos: usize,
    gain: f32,
    looped: bool,
    /// Fade: the level now, where it goes, and by how much a frame.
    level: f32,
    target: f32,
    step: f32,
    /// Gone once silent.
    stopping: bool,
}

impl Voice {
    fn fade(&mut self, to: f32, seconds: f64) {
        self.target = to;
        let frames = (seconds.max(0.0) * RATE as f64).round();
        if frames < 1.0 {
            self.level = to;
            self.step = 0.0;
        } else {
            self.step = ((to - self.level).abs() as f64 / frames) as f32;
        }
    }

    fn done(&self) -> bool {
        (self.stopping && self.level <= 0.0) || (!self.looped && self.pos >= self.pcm.frames())
    }
}

/// The sounds playing on one output, mixed when it asks for samples.
#[derive(Default)]
pub struct Mixer {
    voices: Mutex<Vec<Voice>>,
}

impl Mixer {
    /// Plays a sound (over what already plays), `fade_in` seconds to its volume.
    pub fn play(&self, key: &str, pcm: Arc<Pcm>, gain_db: f64, looped: bool, fade_in: f64) {
        if pcm.frames() == 0 {
            return;
        }
        let mut v = Voice {
            key: key.to_string(),
            pcm,
            pos: 0,
            gain: gain_of(gain_db),
            looped,
            level: 0.0,
            target: 1.0,
            step: 0.0,
            stopping: false,
        };
        v.fade(1.0, fade_in);
        self.lock().push(v);
    }

    /// Stops a sound (all of them: `None`), fading out over `fade_out` seconds.
    pub fn stop(&self, key: Option<&str>, fade_out: f64) {
        let mut voices = self.lock();
        for v in voices.iter_mut() {
            if key.is_none_or(|k| k == v.key) {
                v.stopping = true;
                v.fade(0.0, fade_out);
            }
        }
        voices.retain(|v| !v.done());
    }

    /// The sounds playing (their address).
    pub fn playing(&self) -> Vec<String> {
        self.lock()
            .iter()
            .filter(|v| !v.stopping)
            .map(|v| v.key.clone())
            .collect()
    }

    /// Mixes the next frames into `out` (interleaved stereo, overwritten).
    pub fn fill(&self, out: &mut [f32]) {
        out.fill(0.0);
        let mut voices = self.lock();
        for v in voices.iter_mut() {
            let len = v.pcm.frames();
            for frame in out.as_chunks_mut::<CHANNELS>().0 {
                if v.pos >= len {
                    if v.looped {
                        v.pos = 0;
                    } else {
                        break;
                    }
                }
                if v.level != v.target {
                    v.level = if v.level < v.target {
                        (v.level + v.step).min(v.target)
                    } else {
                        (v.level - v.step).max(v.target)
                    };
                }
                let g = v.gain * v.level;
                let s = &v.pcm.samples[v.pos * CHANNELS..v.pos * CHANNELS + CHANNELS];
                frame[0] += s[0] * g;
                frame[1] += s[1] * g;
                v.pos += 1;
                if v.stopping && v.level <= 0.0 {
                    break;
                }
            }
        }
        voices.retain(|v| !v.done());
        drop(voices);
        for s in out.iter_mut() {
            *s = s.clamp(-1.0, 1.0);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Voice>> {
        self.voices.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ── Settings ──────────────────────────────────────────────────────────────

/// Where an audio output sends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioKind {
    /// AES67 / ST 2110-30 multicast.
    #[default]
    Aes67,
    /// A sound card of the machine (Dante Virtual Soundcard…).
    Device,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default = "crate::on")]
    pub enabled: bool,
    pub name: String,
    #[serde(default)]
    pub kind: AudioKind,
    /// AES67: multicast group and port.
    #[serde(default = "default_dest")]
    pub dest: SocketAddrV4,
    /// AES67: local interface address to send from (the media network).
    #[serde(default)]
    pub interface: Option<Ipv4Addr>,
    #[serde(default = "default_ttl")]
    pub ttl: u32,
    #[serde(default = "default_pt")]
    pub payload_type: u8,
    /// TAI − UTC in seconds: RTP timestamps count TAI.
    #[serde(default = "default_tai")]
    pub tai_offset: u32,
    /// The priority the network gives its packets (DSCP): 34 (AF41) as
    /// AES67 asks, 46 (EF) as Dante does, 0 none.
    #[serde(default = "default_dscp")]
    pub dscp: u8,
    /// Sound card: its name ("" = the system's default output).
    #[serde(default)]
    pub device: String,
    /// Sound card: the first of the two channels sent to (1 = channels 1-2).
    #[serde(default = "default_first")]
    pub first_channel: u16,
}

fn default_dest() -> SocketAddrV4 {
    SocketAddrV4::new(Ipv4Addr::new(239, 69, 10, 10), 5004)
}
fn default_ttl() -> u32 {
    32
}
fn default_pt() -> u8 {
    97
}
fn default_tai() -> u32 {
    37
}
fn default_dscp() -> u8 {
    34
}
fn default_first() -> u16 {
    1
}

impl AudioOutConfig {
    /// Session description of the AES67 stream (`refclk`: the PTP
    /// grandmaster and domain the host follows, "AC-1F-…:0", when known).
    pub fn sdp(&self, refclk: Option<&str>) -> String {
        let src = self.interface.unwrap_or(Ipv4Addr::UNSPECIFIED);
        let refclk = refclk.map_or("traceable".to_string(), str::to_string);
        format!(
            "v=0\r\n\
             o=- {sess} 0 IN IP4 {src}\r\n\
             s={name}\r\n\
             c=IN IP4 {ip}/{ttl}\r\n\
             t=0 0\r\n\
             a=clock-domain:PTPv2 0\r\n\
             m=audio {port} RTP/AVP {pt}\r\n\
             c=IN IP4 {ip}/{ttl}\r\n\
             a=source-filter: incl IN IP4 {ip} {src}\r\n\
             a=rtpmap:{pt} L24/48000/2\r\n\
             a=ptime:1\r\n\
             a=maxptime:1\r\n\
             a=framecount:48\r\n\
             a=ts-refclk:ptp=IEEE1588-2008:{refclk}\r\n\
             a=mediaclk:direct=0\r\n\
             a=recvonly\r\n",
            sess = session_id(self.dest),
            name = self.name,
            ip = self.dest.ip(),
            port = self.dest.port(),
            ttl = self.ttl,
            pt = self.payload_type,
        )
    }
}

fn session_id(dest: SocketAddrV4) -> u32 {
    u32::from(*dest.ip()) ^ dest.port() as u32
}

/// "ac1f6b.fffe.123456" (linuxptp) → "AC-1F-6B-FF-FE-12-34-56" (SDP).
pub fn ptp_clock_id(id: &str) -> Option<String> {
    let hex: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 16 {
        return None;
    }
    Some(
        hex.as_bytes()
            .chunks(2)
            .map(|b| std::str::from_utf8(b).unwrap_or("00").to_ascii_uppercase())
            .collect::<Vec<_>>()
            .join("-"),
    )
}

// ── AES67 / ST 2110-30 ────────────────────────────────────────────────────

/// 48 kHz samples since the epoch (TAI), as ST 2110-10's media clock counts.
fn media_clock(tai_offset: u32) -> u64 {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        + Duration::from_secs(tai_offset as u64);
    d.as_secs() * RATE as u64 + d.subsec_nanos() as u64 * RATE as u64 / 1_000_000_000
}

/// One RTP packet: 12 bytes of header, then 24-bit big-endian samples.
pub fn packet(out: &mut Vec<u8>, pt: u8, seq: u16, ts: u32, ssrc: u32, samples: &[f32]) {
    out.clear();
    out.extend_from_slice(&[0x80, pt & 0x7f]);
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&ts.to_be_bytes());
    out.extend_from_slice(&ssrc.to_be_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
        out.extend_from_slice(&v.to_be_bytes()[1..]);
    }
}

/// A SAP packet announcing (or, `delete`, withdrawing) a session.
pub fn sap(source: Ipv4Addr, id: u16, sdp: &str, delete: bool) -> Vec<u8> {
    let mut p = vec![if delete { 0x24 } else { 0x20 }, 0];
    p.extend_from_slice(&id.to_be_bytes());
    p.extend_from_slice(&source.octets());
    p.extend_from_slice(b"application/sdp\0");
    p.extend_from_slice(sdp.as_bytes());
    p
}

fn open_socket(ttl: u32, interface: Option<Ipv4Addr>, dscp: u8) -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_multicast_ttl_v4(ttl)?;
    // DSCP: the 6 high bits of the TOS byte. Windows applies it only when a
    // QoS policy allows the program: refused, the packets go unmarked.
    if dscp > 0 {
        if let Err(e) = s.set_tos(u32::from(dscp.min(63)) << 2) {
            tracing::warn!("audio: network priority (DSCP {dscp}) not set: {e}");
        }
    }
    if let Some(ip) = interface {
        s.set_multicast_if_v4(&ip)?;
        s.bind(&SocketAddrV4::new(ip, 0).into())?;
    }
    Ok(s.into())
}

/// What a running audio output tells.
#[derive(Default)]
pub struct AudioStats {
    /// Packets (AES67) or callbacks (sound card) sent.
    pub sent: AtomicU64,
    /// The last error ("" when none).
    pub error: Mutex<String>,
}

/// A running audio output: stops when dropped.
pub struct AudioOut {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub stats: Arc<AudioStats>,
}

impl Drop for AudioOut {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl AudioOut {
    /// Starts an output mixing `mixer`. `refclk` gives the PTP clock of the
    /// SDP (read again at each announcement).
    pub fn start(
        config: AudioOutConfig,
        mixer: Arc<Mixer>,
        refclk: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Result<Self, OutputError> {
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(AudioStats::default());
        let thread = match config.kind {
            AudioKind::Aes67 => {
                let socket = open_socket(config.ttl, config.interface, config.dscp)
                    .map_err(|e| OutputError::Message(e.to_string()))?;
                let sap_socket = open_socket(255, config.interface, 0)
                    .map_err(|e| OutputError::Message(e.to_string()))?;
                let (stop2, stats2) = (stop.clone(), stats.clone());
                std::thread::Builder::new()
                    .name(format!("audio {}", config.name))
                    .spawn(move || {
                        send_aes67(
                            &config,
                            &mixer,
                            &socket,
                            &sap_socket,
                            &*refclk,
                            &stop2,
                            &stats2,
                        )
                    })
                    .map_err(|e| OutputError::Message(e.to_string()))?
            }
            AudioKind::Device => device::start(config, mixer, stop.clone(), stats.clone())?,
        };
        Ok(Self {
            stop,
            thread: Some(thread),
            stats,
        })
    }
}

fn send_aes67(
    config: &AudioOutConfig,
    mixer: &Mixer,
    socket: &UdpSocket,
    sap_socket: &UdpSocket,
    refclk: &(dyn Fn() -> Option<String> + Send + Sync),
    stop: &AtomicBool,
    stats: &AudioStats,
) {
    let ssrc = session_id(config.dest) ^ 0x5354_5241;
    let sap_id = (session_id(config.dest) & 0xffff) as u16;
    let source = config.interface.unwrap_or(Ipv4Addr::UNSPECIFIED);
    let mut seq: u16 = 0;
    let mut next = media_clock(config.tai_offset) / PACKET as u64 * PACKET as u64;
    let mut frames = vec![0f32; PACKET * CHANNELS];
    let mut buf = Vec::with_capacity(12 + PACKET * CHANNELS * 3);
    let mut announced: Option<Instant> = None;
    let mut sdp = String::new();
    while !stop.load(Ordering::Relaxed) {
        if announced.is_none_or(|t| t.elapsed() >= SAP_EVERY) {
            sdp = config.sdp(refclk().as_deref());
            let _ = sap_socket.send_to(&sap(source, sap_id, &sdp, false), SAP_GROUP);
            announced = Some(Instant::now());
        }
        let now = media_clock(config.tai_offset);
        // Far behind (the machine slept, the clock jumped): from now on.
        if now > next + RATE as u64 / 5 || next > now + RATE as u64 / 5 {
            next = now / PACKET as u64 * PACKET as u64;
        }
        // Each packet once its millisecond is over.
        while next + PACKET as u64 <= now {
            mixer.fill(&mut frames);
            packet(
                &mut buf,
                config.payload_type,
                seq,
                next as u32,
                ssrc,
                &frames,
            );
            match socket.send_to(&buf, config.dest) {
                Ok(_) => {
                    stats.sent.fetch_add(1, Ordering::Relaxed);
                }
                Err(e) => {
                    *stats.error.lock().unwrap_or_else(|e| e.into_inner()) = e.to_string();
                }
            }
            seq = seq.wrapping_add(1);
            next += PACKET as u64;
        }
        std::thread::sleep(Duration::from_micros(500));
    }
    let _ = sap_socket.send_to(&sap(source, sap_id, &sdp, true), SAP_GROUP);
}

// ── Sound cards ───────────────────────────────────────────────────────────

/// The sound cards able to play (their names).
pub fn devices() -> Vec<String> {
    device::list()
}

#[cfg(any(target_os = "macos", windows))]
mod device {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    pub fn list() -> Vec<String> {
        let host = cpal::default_host();
        host.output_devices()
            .map(|d| d.map(|d| d.to_string()).collect())
            .unwrap_or_default()
    }

    pub fn start(
        config: AudioOutConfig,
        mixer: Arc<Mixer>,
        stop: Arc<AtomicBool>,
        stats: Arc<AudioStats>,
    ) -> Result<std::thread::JoinHandle<()>, OutputError> {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name(format!("audio {}", config.name))
            .spawn(move || {
                // The stream lives on this thread (not Send everywhere).
                let stream = match open(&config, mixer, stats.clone()) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(50));
                }
                let _ = stream.pause();
            })
            .map_err(|e| OutputError::Message(e.to_string()))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(thread),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err(OutputError::Message("sound card thread stopped".into())),
        }
    }

    fn open(
        config: &AudioOutConfig,
        mixer: Arc<Mixer>,
        stats: Arc<AudioStats>,
    ) -> Result<cpal::Stream, OutputError> {
        let host = cpal::default_host();
        let dev = if config.device.trim().is_empty() {
            host.default_output_device()
        } else {
            host.output_devices()
                .ok()
                .and_then(|mut l| l.find(|d| d.to_string() == config.device))
        }
        .ok_or_else(|| OutputError::Message(format!("no sound card « {} »", config.device)))?;
        let channels = dev
            .default_output_config()
            .map(|c| c.channels())
            .unwrap_or(2)
            .max(2);
        let first = (config.first_channel.max(1) - 1).min(channels - 2) as usize;
        let n = channels as usize;
        let mut mix: Vec<f32> = Vec::new();
        let errors = stats.clone();
        let stream = dev
            .build_output_stream::<f32, _, _>(
                cpal::StreamConfig {
                    channels,
                    sample_rate: RATE,
                    buffer_size: cpal::BufferSize::Default,
                },
                move |data: &mut [f32], _| {
                    let frames = data.len() / n;
                    mix.resize(frames * CHANNELS, 0.0);
                    mixer.fill(&mut mix);
                    data.fill(0.0);
                    for (f, s) in data.chunks_exact_mut(n).zip(mix.as_chunks::<CHANNELS>().0) {
                        f[first] = s[0];
                        f[first + 1] = s[1];
                    }
                    stats.sent.fetch_add(1, Ordering::Relaxed);
                },
                move |e| {
                    *errors.error.lock().unwrap_or_else(|e| e.into_inner()) = e.to_string();
                },
                None,
            )
            .map_err(|e| {
                OutputError::Message(format!("{e} (the sound card must run at 48 kHz)"))
            })?;
        stream
            .play()
            .map_err(|e| OutputError::Message(e.to_string()))?;
        Ok(stream)
    }
}

/// Linux: no Dante Virtual Soundcard there; AES67 only.
#[cfg(not(any(target_os = "macos", windows)))]
mod device {
    use super::*;

    pub fn list() -> Vec<String> {
        Vec::new()
    }

    pub fn start(
        _config: AudioOutConfig,
        _mixer: Arc<Mixer>,
        _stop: Arc<AtomicBool>,
        _stats: Arc<AudioStats>,
    ) -> Result<std::thread::JoinHandle<()>, OutputError> {
        Err(OutputError::Message(
            "sound cards are played on macOS and Windows only".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, v: f32) -> Arc<Pcm> {
        Arc::new(Pcm {
            samples: vec![v; frames * CHANNELS],
        })
    }

    #[test]
    fn sounds_are_mixed_at_their_volume() {
        let m = Mixer::default();
        m.play("a", tone(100, 0.25), 0.0, false, 0.0);
        m.play("b", tone(100, 0.5), -6.0206, false, 0.0);
        let mut out = vec![0.0; 10 * CHANNELS];
        m.fill(&mut out);
        assert!((out[0] - 0.5).abs() < 1e-3, "{}", out[0]);
        assert_eq!(m.playing().len(), 2);
    }

    #[test]
    fn a_sound_ends_or_loops() {
        let m = Mixer::default();
        m.play("once", tone(5, 0.1), 0.0, false, 0.0);
        m.play("loop", tone(5, 0.2), 0.0, true, 0.0);
        let mut out = vec![0.0; 12 * CHANNELS];
        m.fill(&mut out);
        assert_eq!(m.playing(), vec!["loop".to_string()]);
        assert!((out[11 * CHANNELS] - 0.2).abs() < 1e-6);
    }

    #[test]
    fn fades_in_and_out() {
        let m = Mixer::default();
        m.play("a", tone(48_000, 1.0), 0.0, true, 0.01);
        let mut out = vec![0.0; 240 * CHANNELS];
        m.fill(&mut out);
        // 480 frames to full volume: half way after 240.
        assert!(
            (out[239 * CHANNELS] - 0.5).abs() < 0.01,
            "{}",
            out[239 * CHANNELS]
        );
        m.stop(Some("a"), 0.001);
        let mut out = vec![0.0; 100 * CHANNELS];
        m.fill(&mut out);
        assert_eq!(out[99 * CHANNELS], 0.0);
        assert!(m.playing().is_empty());
        let mut out = vec![0.0; 10];
        m.fill(&mut out);
        assert!(m.voices.lock().unwrap().is_empty());
    }

    #[test]
    fn mono_files_are_found() {
        assert!(mono_stream(
            "  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, 1 channels, s16, 705 kb/s"
        ));
        assert!(mono_stream(
            "  Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 128 kb/s"
        ));
        assert!(!mono_stream(
            "  Stream #0:0: Audio: aac (LC), 48000 Hz, stereo, fltp"
        ));
    }

    #[test]
    fn packets_carry_24_bit_samples() {
        let mut b = Vec::new();
        packet(&mut b, 97, 7, 0x0102_0304, 9, &[1.0, -1.0, 0.0, 0.5]);
        assert_eq!(b.len(), 12 + 4 * 3);
        assert_eq!(&b[..4], &[0x80, 97, 0, 7]);
        assert_eq!(&b[4..8], &[1, 2, 3, 4]);
        assert_eq!(&b[12..15], &[0x7f, 0xff, 0xff]);
        assert_eq!(&b[15..18], &[0x80, 0x00, 0x01]);
        assert_eq!(&b[18..21], &[0, 0, 0]);
    }

    #[test]
    fn the_sdp_describes_an_aes67_stream() {
        let c: AudioOutConfig = serde_json::from_str(r#"{"name":"Jingles"}"#).unwrap();
        let sdp = c.sdp(
            ptp_clock_id("ac1f6b.fffe.123456")
                .map(|g| format!("{g}:0"))
                .as_deref(),
        );
        assert!(sdp.contains("a=rtpmap:97 L24/48000/2"));
        assert!(sdp.contains("a=ptime:1"));
        assert!(sdp.contains("c=IN IP4 239.69.10.10/32"));
        assert!(sdp.contains("m=audio 5004 RTP/AVP 97"));
        assert!(sdp.contains("ts-refclk:ptp=IEEE1588-2008:AC-1F-6B-FF-FE-12-34-56:0"));
        let p = sap(Ipv4Addr::new(10, 0, 0, 1), 3, &sdp, false);
        assert_eq!(&p[..8], &[0x20, 0, 0, 3, 10, 0, 0, 1]);
        assert!(p.ends_with(sdp.as_bytes()));
    }

    #[test]
    fn packets_are_marked_with_their_priority() {
        let c: AudioOutConfig = serde_json::from_str(r#"{"name":"t"}"#).unwrap();
        assert_eq!(c.dscp, 34);
        let s = open_socket(1, None, 46).unwrap();
        #[cfg(unix)]
        assert_eq!(socket2::SockRef::from(&s).tos().unwrap(), 46 << 2);
        drop(s);
    }

    #[test]
    fn packets_follow_the_media_clock() {
        // A receiver on loopback gets 1 ms packets stamped 48 apart.
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let port = rx.local_addr().unwrap().port();
        let mut c: AudioOutConfig = serde_json::from_str(r#"{"name":"t"}"#).unwrap();
        c.dest = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        let m = Arc::new(Mixer::default());
        m.play("a", tone(48_000, 0.5), 0.0, true, 0.0);
        let out = AudioOut::start(c, m, Arc::new(|| None)).unwrap();
        let mut buf = [0u8; 1500];
        let mut stamps = Vec::new();
        for _ in 0..5 {
            let n = rx.recv(&mut buf).unwrap();
            assert_eq!(n, 12 + 48 * 2 * 3);
            stamps.push(u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]));
        }
        drop(out);
        for w in stamps.windows(2) {
            assert_eq!(w[1].wrapping_sub(w[0]), 48);
        }
        assert_eq!(&buf[12..15], &[0x40, 0, 0]);
    }
}
