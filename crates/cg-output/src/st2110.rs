//! SMPTE ST 2110-20 (uncompressed video over RTP, RFC 4175) sender.
//!
//! Fill and key are sent as two separate essence streams (one thread and
//! socket each), as broadcast keyers expect. This is a pure software implementation:
//! - packets are paced evenly across the frame period (close to the 2110-21
//!   "wide" sender model) from a dedicated thread;
//! - RTP timestamps derive from the system clock. For production use the host
//!   must be PTP-disciplined (ptp4l + phc2sys) so system time follows the
//!   facility grandmaster; they count TAI (system time + `tai_offset`), as
//!   ST 2110-10 asks. Kernel-bypass NICs (DPDK / Rivermax) are on the
//!   roadmap for tighter pacing at UHD rates;
//! - SMPTE 2022-7: with a blue leg, every packet goes out on both networks
//!   (same sequence numbers and timestamps), so a receiver loses nothing
//!   when one network fails.

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cg_render::Frame;
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};

use crate::colorspace::{pack_line_4224_10, pack_line_422_10, pack_line_rgba8};
use crate::{OutputError, OutputSink};

/// RTP payload bytes per packet. 1200 = 240 pgroups (480 px), fits a 1500 MTU
/// with RTP + RFC 4175 headers and divides 1920/1280/3840 line widths.
const PAYLOAD_BYTES: usize = 1200;
/// RTP header (12 bytes) and RFC 4175 payload header (8, one line segment).
const HEADER_BYTES: usize = 20;
const RTP_CLOCK: f64 = 90_000.0;

/// How the picture and its alpha travel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum St2110Encoding {
    /// Two ST 2110-20 streams: YCbCr 4:2:2 10-bit fill and its key.
    #[default]
    FillKey,
    /// One stream, RGBA 4:4:4:4 8-bit.
    Rgba,
    /// One stream, YCbCr + alpha 4:2:2:4 10-bit.
    Ycbcra,
}

/// One RTP stream of a sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Essence {
    Fill,
    Key,
    Rgba,
    Ycbcra,
}

impl Essence {
    /// (bytes, pixels) of one pgroup.
    fn pgroup(self) -> (usize, usize) {
        match self {
            Essence::Fill | Essence::Key => (5, 2),
            Essence::Rgba => (4, 1),
            Essence::Ycbcra => (15, 4),
        }
    }

    fn pack(self, rgba: &[u8], out: &mut Vec<u8>) {
        match self {
            Essence::Fill => pack_line_422_10(rgba, out, false),
            Essence::Key => pack_line_422_10(rgba, out, true),
            Essence::Rgba => pack_line_rgba8(rgba, out),
            Essence::Ycbcra => pack_line_4224_10(rgba, out),
        }
    }

    /// SDP `sampling` and `depth`.
    fn sampling(self) -> (&'static str, u8) {
        match self {
            Essence::Fill => ("YCbCr-4:2:2", 10),
            Essence::Key => ("KEY", 10),
            Essence::Rgba => ("RGBA", 8),
            Essence::Ycbcra => ("YCbCrA-4:2:2:4", 10),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Essence::Fill => "fill",
            Essence::Key => "key",
            Essence::Rgba => "rgba",
            Essence::Ycbcra => "ycbcra",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct St2110Config {
    /// Stable id (layout, status, SDP links).
    #[serde(default)]
    pub id: String,
    /// Off: kept in the settings, not started.
    #[serde(default = "crate::on")]
    pub enabled: bool,
    pub name: String,
    /// The flow of the Hardware settings this sends ("" = none): the server
    /// fills the fields below from it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hardware: String,
    #[serde(default)]
    pub encoding: St2110Encoding,
    /// Multicast group (or unicast) for the fill stream.
    pub fill: SocketAddrV4,
    /// Key (alpha) stream of the fill + key encoding.
    #[serde(default)]
    pub key: Option<SocketAddrV4>,
    /// Local interface address to send from.
    #[serde(default)]
    pub interface: Option<Ipv4Addr>,
    /// SMPTE 2022-7 copy on the secondary (blue) network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blue: Option<Leg>,
    #[serde(default = "default_ttl")]
    pub ttl: u32,
    #[serde(default = "default_pt")]
    pub payload_type: u8,
    /// TAI − UTC in seconds: RTP timestamps count TAI.
    #[serde(default = "default_tai")]
    pub tai_offset: u32,
}

/// The blue (2022-7 secondary) destinations of a sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Leg {
    pub fill: SocketAddrV4,
    #[serde(default)]
    pub key: Option<SocketAddrV4>,
    #[serde(default)]
    pub interface: Option<Ipv4Addr>,
}

fn default_ttl() -> u32 {
    32
}
fn default_pt() -> u8 {
    96
}
fn default_tai() -> u32 {
    37
}

/// One RTP stream of a sender and where it goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamDest {
    pub essence: Essence,
    pub red: SocketAddrV4,
    /// Its 2022-7 copy.
    pub blue: Option<SocketAddrV4>,
}

impl St2110Config {
    /// The streams this sender sends, with their destinations.
    pub fn streams(&self) -> Vec<StreamDest> {
        let blue = |key: bool| {
            self.blue
                .and_then(|l| if key { l.key } else { Some(l.fill) })
        };
        let one = |essence| StreamDest {
            essence,
            red: self.fill,
            blue: blue(false),
        };
        match self.encoding {
            St2110Encoding::FillKey => std::iter::once(one(Essence::Fill))
                .chain(self.key.map(|k| StreamDest {
                    essence: Essence::Key,
                    red: k,
                    blue: blue(true),
                }))
                .collect(),
            St2110Encoding::Rgba => vec![one(Essence::Rgba)],
            St2110Encoding::Ycbcra => vec![one(Essence::Ycbcra)],
        }
    }

    /// Session description for one stream (`key = true`: the key of a
    /// fill + key pair; otherwise the main stream). With a blue leg it
    /// describes both paths (RFC 7104 duplication, as 2022-7 receivers expect).
    pub fn sdp(&self, width: u32, height: u32, rate: (u32, u32), key: bool) -> Option<String> {
        let d = self
            .streams()
            .into_iter()
            .find(|d| (d.essence == Essence::Key) == key)?;
        let rate = if rate.1 == 1 {
            rate.0.to_string()
        } else {
            format!("{}/{}", rate.0, rate.1)
        };
        let (sampling, depth) = d.essence.sampling();
        let red_src = self.interface.unwrap_or(Ipv4Addr::UNSPECIFIED);
        let media = |dest: SocketAddrV4, src: Ipv4Addr, mid: Option<&str>| {
            format!(
                "m=video {port} RTP/AVP {pt}\r\n\
                 c=IN IP4 {ip}/{ttl}\r\n\
                 a=source-filter: incl IN IP4 {ip} {src}\r\n\
                 a=rtpmap:{pt} raw/90000\r\n\
                 a=fmtp:{pt} sampling={sampling}; width={width}; height={height}; exactframerate={rate}; depth={depth}; TCS=SDR; colorimetry=BT709; PM=2110GPM; SSN=ST2110-20:2017; TP=2110TPW; \r\n\
                 a=ts-refclk:ptp=IEEE1588-2008:traceable\r\n\
                 a=mediaclk:direct=0\r\n{mid}",
                port = dest.port(),
                pt = self.payload_type,
                ip = dest.ip(),
                ttl = self.ttl,
                mid = mid.map_or(String::new(), |m| format!("a=mid:{m}\r\n")),
            )
        };
        let mut sdp = format!(
            "v=0\r\n\
             o=- {sess} 0 IN IP4 {red_src}\r\n\
             s={name} ({label})\r\n\
             t=0 0\r\n",
            sess = u32::from(d.red.ip().to_owned()) ^ d.red.port() as u32,
            name = self.name,
            label = d.essence.label(),
        );
        match d.blue {
            Some(blue) => {
                let blue_src = self
                    .blue
                    .and_then(|l| l.interface)
                    .unwrap_or(Ipv4Addr::UNSPECIFIED);
                sdp.push_str("a=group:DUP primary secondary\r\n");
                sdp.push_str(&media(d.red, red_src, Some("primary")));
                sdp.push_str(&media(blue, blue_src, Some("secondary")));
            }
            None => sdp.push_str(&media(d.red, red_src, None)),
        }
        Some(sdp)
    }
}

/// RTP packets of one frame, stored back to back in a single buffer.
#[derive(Default)]
pub struct Packets {
    buf: Vec<u8>,
    ends: Vec<usize>,
}

impl Packets {
    pub fn len(&self) -> usize {
        self.ends.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }
    pub fn get(&self, i: usize) -> &[u8] {
        let start = if i == 0 { 0 } else { self.ends[i - 1] };
        &self.buf[start..self.ends[i]]
    }
    pub fn iter(&self) -> impl Iterator<Item = &[u8]> {
        (0..self.len()).map(|i| self.get(i))
    }
}

/// Splits a frame into RFC 4175 RTP packets (single line segment per packet).
pub fn packetize_into(
    frame: &Frame,
    essence: Essence,
    pt: u8,
    seq: &mut u32,
    timestamp: u32,
    out: &mut Packets,
    line: &mut Vec<u8>,
) {
    let (w, h) = (frame.width as usize, frame.height as usize);
    out.buf.clear();
    out.ends.clear();
    for y in 0..h {
        essence.pack(&frame.data[y * w * 4..(y + 1) * w * 4], line);
        let (pg_bytes, pg_px) = essence.pgroup();
        let mut offset_bytes = 0;
        while offset_bytes < line.len() {
            let len = (PAYLOAD_BYTES / pg_bytes * pg_bytes).min(line.len() - offset_bytes);
            let last = y == h - 1 && offset_bytes + len >= line.len();
            let p = &mut out.buf;
            // RTP header
            p.push(0x80);
            p.push(if last { 0x80 | pt } else { pt });
            p.extend_from_slice(&(*seq as u16).to_be_bytes());
            p.extend_from_slice(&timestamp.to_be_bytes());
            p.extend_from_slice(&0x2110_0000u32.to_be_bytes()); // SSRC
                                                                // RFC 4175 payload header
            p.extend_from_slice(&((*seq >> 16) as u16).to_be_bytes()); // extended seq
            p.extend_from_slice(&(len as u16).to_be_bytes());
            p.extend_from_slice(&((y as u16) & 0x7fff).to_be_bytes()); // F=0, line
            let pixel_offset = (offset_bytes / pg_bytes * pg_px) as u16;
            p.extend_from_slice(&(pixel_offset & 0x7fff).to_be_bytes()); // C=0
            p.extend_from_slice(&line[offset_bytes..offset_bytes + len]);
            out.ends.push(p.len());
            *seq = seq.wrapping_add(1);
            offset_bytes += len;
        }
    }
}

/// The packets of the picture sent last (`out`) made the packets of `frame`
/// (same size), whose rows `rows` changed: those lines packed again, in
/// place, then every packet restamped. False when the layout differs
/// (`packetize_into` is then needed).
pub fn repacketize(
    frame: &Frame,
    essence: Essence,
    rows: &[bool],
    seq: &mut u32,
    timestamp: u32,
    out: &mut Packets,
    line: &mut Vec<u8>,
) -> bool {
    let (w, h) = (frame.width as usize, frame.height as usize);
    if rows.len() != h || h == 0 || !out.ends.len().is_multiple_of(h) {
        return false;
    }
    let per_line = out.ends.len() / h;
    for (y, _) in rows.iter().enumerate().filter(|(_, c)| **c) {
        essence.pack(&frame.data[y * w * 4..(y + 1) * w * 4], line);
        let mut offset = 0;
        for k in y * per_line..(y + 1) * per_line {
            let start = if k == 0 { 0 } else { out.ends[k - 1] } + HEADER_BYTES;
            let end = out.ends[k];
            let len = end - start;
            if offset + len > line.len() {
                return false;
            }
            out.buf[start..end].copy_from_slice(&line[offset..offset + len]);
            offset += len;
        }
        if offset != line.len() {
            return false;
        }
    }
    restamp(out, seq, timestamp);
    true
}

/// The packets of the picture sent last, for the same picture again: only
/// their sequence numbers and timestamp change (what `packetize_into` would
/// make, without converting the picture again).
pub fn restamp(out: &mut Packets, seq: &mut u32, timestamp: u32) {
    let mut start = 0;
    for &end in &out.ends {
        let p = &mut out.buf[start..end];
        p[2..4].copy_from_slice(&(*seq as u16).to_be_bytes());
        p[4..8].copy_from_slice(&timestamp.to_be_bytes());
        p[12..14].copy_from_slice(&((*seq >> 16) as u16).to_be_bytes());
        *seq = seq.wrapping_add(1);
        start = end;
    }
}

pub fn packetize(
    frame: &Frame,
    essence: Essence,
    pt: u8,
    seq: &mut u32,
    timestamp: u32,
) -> Packets {
    let mut out = Packets::default();
    packetize_into(
        frame,
        essence,
        pt,
        seq,
        timestamp,
        &mut out,
        &mut Vec::new(),
    );
    out
}

fn open_socket(ttl: u32, interface: Option<Ipv4Addr>) -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_multicast_ttl_v4(ttl)?;
    if let Some(ip) = interface {
        s.set_multicast_if_v4(&ip)?;
        s.bind(&SocketAddrV4::new(ip, 0).into())?;
    }
    s.set_send_buffer_size(8 << 20).ok();
    Ok(s.into())
}

/// One stream = one socket + one pacing thread.
struct Stream {
    tx: SyncSender<(Arc<Frame>, SystemTime)>,
}

pub struct St2110Sender {
    essences: Vec<Stream>,
    config: St2110Config,
    /// µs its threads spent packetizing and sending (not pacing).
    busy_us: Arc<AtomicU64>,
}

impl St2110Sender {
    pub fn start(config: St2110Config, frame_period: Duration) -> Result<Self, OutputError> {
        let mut essences = Vec::new();
        let busy_us = Arc::new(AtomicU64::new(0));
        for d in config.streams() {
            let mut legs = vec![(open_socket(config.ttl, config.interface)?, d.red)];
            if let Some(blue) = d.blue {
                let interface = config.blue.and_then(|l| l.interface);
                legs.push((open_socket(config.ttl, interface)?, blue));
            }
            let (tx, rx) = sync_channel::<(Arc<Frame>, SystemTime)>(2);
            let essence = d.essence;
            let send = Sending {
                name: config.name.clone(),
                legs,
                essence,
                pt: config.payload_type,
                tai: Duration::from_secs(config.tai_offset.into()),
                period: frame_period,
            };
            let busy = busy_us.clone();
            std::thread::Builder::new()
                .name(format!("st2110-{}-{}", config.name, essence.label()))
                .spawn(move || run(send, rx, &busy))
                .map_err(OutputError::Io)?;
            essences.push(Stream { tx });
        }
        tracing::info!(fill = %config.fill, key = ?config.key, blue = ?config.blue, encoding = ?config.encoding, "ST 2110-20 sender started");
        Ok(Self {
            essences,
            config,
            busy_us,
        })
    }

    pub fn config(&self) -> &St2110Config {
        &self.config
    }
}

/// What one stream thread sends, and where.
struct Sending {
    name: String,
    /// Red, then blue (2022-7).
    legs: Vec<(UdpSocket, SocketAddrV4)>,
    essence: Essence,
    pt: u8,
    /// TAI − UTC.
    tai: Duration,
    period: Duration,
}

fn run(send: Sending, rx: Receiver<(Arc<Frame>, SystemTime)>, busy: &AtomicU64) {
    let Sending {
        name,
        legs,
        essence,
        pt,
        tai,
        period,
    } = send;
    let mut seq = 0u32;
    let (mut packets, mut line) = (Packets::default(), Vec::new());
    let mut last: Option<Arc<Frame>> = None;
    let (mut frames, mut stats_at) = (0u32, Instant::now());
    while let Ok((frame, at)) = rx.recv() {
        let start = Instant::now();
        frames += 1;
        if stats_at.elapsed() >= Duration::from_secs(5) {
            tracing::debug!(
                name,
                stream = essence.label(),
                fps = frames as f64 / stats_at.elapsed().as_secs_f64(),
                "ST 2110 send rate"
            );
            (frames, stats_at) = (0, Instant::now());
        }
        // Fill and key threads derive the same timestamp from the frame's
        // capture time so receivers can pair them.
        let ts = rtp_timestamp(frame_time(at) + tai);
        // The same picture as the last one (nothing moved): its packets
        // again; else only the lines that changed are packed again.
        if last.as_ref().is_some_and(|l| Arc::ptr_eq(l, &frame)) {
            restamp(&mut packets, &mut seq, ts);
        } else {
            let again = crate::changed_rows(&frame, last.as_deref()).is_some_and(|rows| {
                let before = seq;
                let done = repacketize(
                    &frame,
                    essence,
                    &rows,
                    &mut seq,
                    ts,
                    &mut packets,
                    &mut line,
                );
                if !done {
                    seq = before;
                }
                done
            });
            if !again {
                packetize_into(&frame, essence, pt, &mut seq, ts, &mut packets, &mut line);
            }
            last = Some(frame.clone());
        }
        // Pace across what is left of ~90% of the frame period.
        let budget = period.mul_f64(0.9).saturating_sub(start.elapsed());
        let send_start = Instant::now();
        let n = packets.len();
        let mut paced = Duration::ZERO;
        for (i, p) in packets.iter().enumerate() {
            for (socket, dest) in &legs {
                let _ = socket.send_to(p, dest);
            }
            if i % 64 == 63 {
                let due = budget.mul_f64((i + 1) as f64 / n as f64);
                let elapsed = send_start.elapsed();
                if due > elapsed {
                    std::thread::sleep(due - elapsed);
                    paced += due - elapsed;
                }
            }
        }
        let worked = start.elapsed().saturating_sub(paced);
        busy.fetch_add(worked.as_micros() as u64, Ordering::Relaxed);
    }
    tracing::info!(name, stream = essence.label(), "ST 2110 sender stopped");
}

/// 90 kHz ticks since the epoch, modulo 2³² (ST 2110-10).
fn rtp_timestamp(since_epoch: Duration) -> u32 {
    let ticks = since_epoch.as_secs() as u128 * RTP_CLOCK as u128
        + since_epoch.subsec_nanos() as u128 * RTP_CLOCK as u128 / 1_000_000_000;
    ticks as u32
}

fn frame_time(at: SystemTime) -> Duration {
    at.duration_since(UNIX_EPOCH).unwrap_or_default()
}

impl OutputSink for St2110Sender {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn work_time(&self) -> Option<Duration> {
        Some(Duration::from_micros(self.busy_us.load(Ordering::Relaxed)))
    }

    fn push(&mut self, frame: &Arc<Frame>, at: SystemTime) -> Result<(), OutputError> {
        let mut result = Ok(());
        for e in &self.essences {
            match e.tx.try_send((frame.clone(), at)) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => result = Err(OutputError::Dropped),
                Err(TrySendError::Disconnected(_)) => return Err(OutputError::Closed),
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_count_and_marker() {
        let f = Frame::blank(1920, 1080);
        let mut seq = 0;
        let pkts = packetize(&f, Essence::Fill, 96, &mut seq, 1234);
        // 1920 px * 2.5 B = 4800 B per line = 4 packets.
        assert_eq!(pkts.len(), 1080 * 4);
        assert_eq!(seq, 1080 * 4);
        let last = pkts.get(pkts.len() - 1);
        assert_eq!(last[1], 0x80 | 96);
        assert_eq!(pkts.get(0)[1], 96);
        assert_eq!(pkts.get(0).len(), 12 + 8 + 1200);
        // Second packet of line 0 starts at pixel 480.
        assert_eq!(u16::from_be_bytes([pkts.get(1)[18], pkts.get(1)[19]]), 480);
    }

    #[test]
    fn changed_lines_only_are_packed_again() {
        let mut old = Frame::blank(64, 6);
        for (i, b) in old.data.iter_mut().enumerate() {
            *b = (i * 7 % 251) as u8;
        }
        let mut new = old.clone();
        for b in &mut new.data[64 * 4 * 2..64 * 4 * 4] {
            *b = b.wrapping_add(3);
        }
        let rows = crate::changed_rows(&new, Some(&old)).unwrap();
        assert_eq!(rows, [false, false, true, true, false, false]);
        for essence in [Essence::Fill, Essence::Key, Essence::Rgba, Essence::Ycbcra] {
            let mut seq = 0xfffe;
            let mut line = Vec::new();
            let mut again = packetize(&old, essence, 96, &mut seq, 1234);
            let mut seq2 = seq;
            assert!(repacketize(
                &new, essence, &rows, &mut seq2, 5678, &mut again, &mut line
            ));
            let want = packetize(&new, essence, 96, &mut seq, 5678);
            assert_eq!(seq, seq2);
            assert_eq!(again.buf, want.buf);
            assert_eq!(again.ends, want.ends);
        }
    }

    #[test]
    fn the_same_picture_again_is_only_restamped() {
        let mut f = Frame::blank(64, 4);
        for (i, b) in f.data.iter_mut().enumerate() {
            *b = (i * 7 % 251) as u8;
        }
        for essence in [Essence::Fill, Essence::Rgba, Essence::Ycbcra] {
            let mut seq = 0xfffe;
            let mut again = packetize(&f, essence, 96, &mut seq, 1234);
            let mut seq2 = seq;
            restamp(&mut again, &mut seq2, 5678);
            let want = packetize(&f, essence, 96, &mut seq, 5678);
            assert_eq!(seq, seq2);
            assert_eq!(again.buf, want.buf);
            assert_eq!(again.ends, want.ends);
        }
    }

    #[test]
    fn sdp_contains_format() {
        let cfg = St2110Config {
            enabled: true,
            id: "a".into(),
            hardware: String::new(),
            encoding: St2110Encoding::FillKey,
            name: "CG1".into(),
            fill: "239.10.0.1:5004".parse().unwrap(),
            key: Some("239.10.0.2:5004".parse().unwrap()),
            interface: Some("10.0.0.5".parse().unwrap()),
            blue: None,
            ttl: 16,
            payload_type: 96,
            tai_offset: 37,
        };
        let sdp = cfg.sdp(1920, 1080, (60000, 1001), true).unwrap();
        assert!(sdp.contains("c=IN IP4 239.10.0.2/16"));
        assert!(sdp.contains("exactframerate=60000/1001"));
        assert!(sdp.contains("sampling=KEY"));
        let one = St2110Config {
            enabled: true,
            encoding: St2110Encoding::Ycbcra,
            ..cfg
        };
        assert_eq!(one.streams().len(), 1);
        let sdp = one.sdp(1920, 1080, (50, 1), false).unwrap();
        assert!(sdp.contains("sampling=YCbCrA-4:2:2:4") && sdp.contains("depth=10"));
        assert!(one.sdp(1920, 1080, (50, 1), true).is_none());
    }

    #[test]
    fn a_blue_leg_doubles_every_stream() {
        let cfg = St2110Config {
            id: "a".into(),
            enabled: true,
            name: "CG".into(),
            hardware: String::new(),
            encoding: St2110Encoding::FillKey,
            fill: "239.1.0.1:5004".parse().unwrap(),
            key: Some("239.1.0.2:5004".parse().unwrap()),
            interface: Some("10.1.0.5".parse().unwrap()),
            blue: Some(Leg {
                fill: "239.2.0.1:5004".parse().unwrap(),
                key: Some("239.2.0.2:5004".parse().unwrap()),
                interface: Some("10.2.0.5".parse().unwrap()),
            }),
            ttl: 32,
            payload_type: 96,
            tai_offset: 37,
        };
        let s = cfg.streams();
        assert_eq!(s.len(), 2);
        assert_eq!(s[1].blue, Some("239.2.0.2:5004".parse().unwrap()));
        let sdp = cfg.sdp(1920, 1080, (50, 1), true).unwrap();
        assert!(sdp.contains("a=group:DUP primary secondary"));
        assert!(sdp.contains("c=IN IP4 239.1.0.2/32") && sdp.contains("c=IN IP4 239.2.0.2/32"));
        assert!(sdp.contains("incl IN IP4 239.2.0.2 10.2.0.5"));
        assert!(sdp.contains("a=mid:primary") && sdp.contains("a=mid:secondary"));
        assert_eq!(sdp.matches("m=video").count(), 2);
    }

    #[test]
    fn rtp_timestamps_count_90khz_and_wrap() {
        assert_eq!(rtp_timestamp(Duration::from_secs(1)), 90_000);
        assert_eq!(rtp_timestamp(Duration::from_millis(20)), 1_800);
        // 2³² ticks later it wraps to the same value.
        let wrap = Duration::from_secs_f64(4_294_967_296.0 / 90_000.0);
        let t = Duration::from_secs(1_700_000_000);
        assert!(rtp_timestamp(t + wrap).abs_diff(rtp_timestamp(t)) <= 1);
    }

    #[test]
    fn one_stream_pgroups() {
        let f = Frame::blank(1920, 1080);
        let mut seq = 0;
        // RGBA: 7680 B per line, 1200 B per packet.
        let p = packetize(&f, Essence::Rgba, 96, &mut seq, 0);
        assert_eq!(p.len(), 1080 * 7);
        assert_eq!(u16::from_be_bytes([p.get(1)[18], p.get(1)[19]]), 300);
        // YCbCrA: 480 pgroups of 15 B = 7200 B per line, 80 pgroups a packet.
        let p = packetize(&f, Essence::Ycbcra, 96, &mut seq, 0);
        assert_eq!(p.len(), 1080 * 6);
        assert_eq!(u16::from_be_bytes([p.get(1)[18], p.get(1)[19]]), 320);
    }
}
