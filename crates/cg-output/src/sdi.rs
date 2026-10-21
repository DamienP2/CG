//! SDI through Blackmagic DeckLink cards: outputs (fill + key) and inputs.
//!
//! The DeckLink SDK is reached through a small C++ shim (`decklink/`,
//! bindings in [`crate::decklink`]) built with the `decklink` feature. The
//! runtime, Blackmagic Desktop Video, is loaded when a card is used: without
//! it, or in a build without the shim, opening a device fails with
//! `OutputError::Unsupported` and the rest of the server keeps working.
//!
//! Output: frames are handed over as BGRA 8-bit premultiplied
//! (bmdFormat8BitBGRA), which the card turns into fill (and key, through its
//! keyer: external = fill on one SDI, key on the next; internal = the fill
//! keyed over the card's SDI input). They are scheduled a few frames ahead
//! of the card's playback clock from a sender thread of their own, the
//! newest frame winning, so the channel never waits on the driver. That
//! clock, locked to the card's reference input when one is connected, is
//! offered to the channel as its [`FrameClock`] when the output is set to
//! genlock.
//!
//! Input: the card captures 8-bit 4:2:2 (UYVY) and follows the incoming
//! format when it can detect it; [`DeckLinkInput::take`] converts the newest
//! frame to RGBA (BT.709).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use cg_render::Frame;
use serde::{Deserialize, Serialize};

use crate::decklink::{InputHandle, Keyer, OutputHandle, Pushed};
use crate::{FrameClock, OutputError, OutputSink};

pub use crate::decklink::devices;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdiConfig {
    #[serde(default)]
    pub id: String,
    /// Off: kept in the settings, not started.
    #[serde(default = "crate::on")]
    pub enabled: bool,
    pub name: String,
    /// The SDI output of the Hardware settings this sends to ("" = none):
    /// the server fills the fields below from it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hardware: String,
    /// DeckLink device index (as listed by Desktop Video).
    pub device: u32,
    /// Use the card's external keyer (fill on SDI A, key on SDI B); off:
    /// the card's internal keyer over its SDI input.
    #[serde(default = "yes")]
    pub external_key: bool,
    /// Fill only, no key.
    #[serde(default)]
    pub fill_only: bool,
    /// Lock to the card's reference input: the channel then runs on the
    /// card's frame clock (see [`OutputSink::frame_clock`]).
    #[serde(default)]
    pub genlock: bool,
}

impl SdiConfig {
    pub fn keyer(&self) -> Keyer {
        if self.fill_only {
            Keyer::None
        } else if self.external_key {
            Keyer::External
        } else {
            Keyer::Internal
        }
    }
}

/// This build drives DeckLink cards (the shim is built in; the cards still
/// need Blackmagic Desktop Video at run time).
pub const SUPPORTED: bool = crate::decklink::BUILT;

fn yes() -> bool {
    true
}

/// The frame waiting for the sender thread (the newest wins).
#[derive(Default)]
struct Slot {
    state: Mutex<SlotState>,
    ready: Condvar,
}

#[derive(Default)]
struct SlotState {
    frame: Option<Arc<Frame>>,
    /// Set by the output on drop, or by the thread when it stops.
    closed: bool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub struct DeckLinkOutput {
    config: SdiConfig,
    slot: Arc<Slot>,
    /// µs the sender thread spent converting and copying frames.
    busy_us: Arc<AtomicU64>,
    clock: Option<Arc<dyn FrameClock>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// The card's frame clock (shares the output; the card is closed once the
/// output and every clock are gone).
struct CardClock(Arc<OutputHandle>);

impl FrameClock for CardClock {
    fn wait(&self, timeout: Duration) -> bool {
        self.0.wait(timeout)
    }
    fn locked(&self) -> Option<bool> {
        self.0.reference_locked()
    }
}

impl DeckLinkOutput {
    /// Opens the device's output in the mode matching the channel format
    /// (width × height at `rate` frames per second, as num/den).
    pub fn open(
        config: SdiConfig,
        width: u32,
        height: u32,
        rate: (u32, u32),
    ) -> Result<Self, OutputError> {
        let handle = OutputHandle::open(config.device, width, height, rate, config.keyer())
            .map_err(OutputError::Unsupported)?;
        let handle = Arc::new(handle);
        tracing::info!(
            name = config.name,
            device = config.device,
            mode = handle.mode.name,
            keyer = ?config.keyer(),
            genlock = config.genlock,
            "DeckLink output started"
        );
        let clock = config
            .genlock
            .then(|| Arc::new(CardClock(handle.clone())) as Arc<dyn FrameClock>);
        let slot = Arc::new(Slot::default());
        let busy_us = Arc::new(AtomicU64::new(0));
        let thread = {
            let (slot, busy, name) = (slot.clone(), busy_us.clone(), config.name.clone());
            let opaque = config.fill_only;
            std::thread::Builder::new()
                .name(format!("sdi-{}", config.name))
                .spawn(move || send(name, handle, slot, busy, opaque))
                .map_err(OutputError::Io)?
        };
        Ok(Self {
            config,
            slot,
            busy_us,
            clock,
            thread: Some(thread),
        })
    }

    /// RGBA → BGRA swizzle, the native DeckLink pixel format.
    pub fn to_bgra(frame: &Frame, out: &mut Vec<u8>) {
        swizzle(&frame.data, out, false);
    }
}

/// RGBA → BGRA; `opaque`: alpha forced to 255 (fill only: the premultiplied
/// fill is then the picture over black).
fn swizzle(rgba: &[u8], out: &mut Vec<u8>, opaque: bool) {
    out.clear();
    out.reserve(rgba.len());
    for px in rgba.as_chunks::<4>().0 {
        out.extend_from_slice(&[px[2], px[1], px[0], if opaque { 255 } else { px[3] }]);
    }
}

fn send(
    name: String,
    card: Arc<OutputHandle>,
    slot: Arc<Slot>,
    busy: Arc<AtomicU64>,
    opaque: bool,
) {
    let mut bgra = Vec::new();
    let (mut failed, mut warned_at) = (0u32, None::<Instant>);
    loop {
        let frame = {
            let mut s = lock(&slot.state);
            loop {
                if s.closed {
                    break None;
                }
                if let Some(f) = s.frame.take() {
                    break Some(f);
                }
                s = slot.ready.wait(s).unwrap_or_else(|p| p.into_inner());
            }
        };
        let Some(frame) = frame else { break };
        let start = Instant::now();
        if frame.width != card.width || frame.height != card.height {
            if warned_at.is_none_or(|t| t.elapsed() > Duration::from_secs(10)) {
                tracing::warn!(
                    name,
                    "frame {}x{} does not match the SDI mode {}",
                    frame.width,
                    frame.height,
                    card.mode.name
                );
                warned_at = Some(Instant::now());
            }
            continue;
        }
        swizzle(&frame.data, &mut bgra, opaque);
        match card.push(&bgra, card.width as usize * 4) {
            Pushed::Queued | Pushed::Dropped => failed = 0,
            Pushed::Failed => {
                failed += 1;
                if failed == 1 || failed % 250 == 0 {
                    tracing::warn!(name, failed, "DeckLink refused a frame");
                }
            }
        }
        busy.fetch_add(start.elapsed().as_micros() as u64, Ordering::Relaxed);
    }
    lock(&slot.state).closed = true;
    tracing::info!(name, "DeckLink output stopped");
}

impl OutputSink for DeckLinkOutput {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn push(&mut self, frame: &Arc<Frame>, _at: SystemTime) -> Result<(), OutputError> {
        let mut s = lock(&self.slot.state);
        if s.closed {
            return Err(OutputError::Closed);
        }
        let replaced = s.frame.replace(frame.clone()).is_some();
        drop(s);
        self.slot.ready.notify_one();
        if replaced {
            Err(OutputError::Dropped)
        } else {
            Ok(())
        }
    }

    fn work_time(&self) -> Option<Duration> {
        Some(Duration::from_micros(self.busy_us.load(Ordering::Relaxed)))
    }

    fn frame_clock(&self) -> Option<Arc<dyn FrameClock>> {
        self.clock.clone()
    }
}

impl Drop for DeckLinkOutput {
    fn drop(&mut self) {
        lock(&self.slot.state).closed = true;
        self.slot.ready.notify_one();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// An SDI input of a DeckLink card.
pub struct DeckLinkInput {
    card: InputHandle,
    uyvy: Vec<u8>,
}

impl DeckLinkInput {
    /// Opens the device's input in the mode matching width × height at
    /// `rate`; the card then follows the incoming format if it can.
    pub fn open(device: u32, width: u32, height: u32, rate: (u32, u32)) -> Result<Self, String> {
        let card = InputHandle::open(device, width, height, rate)?;
        tracing::info!(device, mode = card.mode.name, "DeckLink input started");
        Ok(Self {
            card,
            uyvy: Vec::new(),
        })
    }

    /// The newest captured picture, as (width, height, RGBA), when newer
    /// than `*seq` (updated). Start with `*seq = 0`.
    pub fn take(&mut self, seq: &mut u64) -> Option<(u32, u32, Vec<u8>)> {
        let (w, h) = self.card.take(&mut self.uyvy, seq)?;
        let mut rgba = Vec::new();
        crate::colorspace::uyvy_to_rgba709(&self.uyvy, w as usize, h as usize, &mut rgba);
        Some((w, h, rgba))
    }

    /// A signal is coming in (None: nothing received yet).
    pub fn signal(&self) -> Option<bool> {
        self.card.signal()
    }

    /// The display mode opened (e.g. "1080i50").
    pub fn mode_name(&self) -> &str {
        &self.card.mode.name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_swizzle() {
        let mut out = Vec::new();
        swizzle(&[1, 2, 3, 4, 5, 6, 7, 0], &mut out, false);
        assert_eq!(out, [3, 2, 1, 4, 7, 6, 5, 0]);
        swizzle(&[1, 2, 3, 4, 5, 6, 7, 0], &mut out, true);
        assert_eq!(out, [3, 2, 1, 255, 7, 6, 5, 255]);
        let mut f = Frame::blank(2, 1);
        f.data.copy_from_slice(&[10, 20, 30, 40, 50, 60, 70, 80]);
        DeckLinkOutput::to_bgra(&f, &mut out);
        assert_eq!(out, [30, 20, 10, 40, 70, 60, 50, 80]);
    }

    #[test]
    fn keyer_from_config() {
        let mut c = SdiConfig {
            id: String::new(),
            enabled: true,
            name: "sdi".into(),
            hardware: String::new(),
            device: 0,
            external_key: true,
            fill_only: false,
            genlock: false,
        };
        assert_eq!(c.keyer(), Keyer::External);
        c.external_key = false;
        assert_eq!(c.keyer(), Keyer::Internal);
        c.fill_only = true;
        assert_eq!(c.keyer(), Keyer::None);
    }

    #[test]
    fn open_fails_cleanly_without_a_card() {
        // No DeckLink card (or no shim) here: an error, never a panic.
        let c = SdiConfig {
            id: String::new(),
            enabled: true,
            name: "sdi".into(),
            hardware: String::new(),
            device: 0,
            external_key: true,
            fill_only: false,
            genlock: true,
        };
        if devices().map(|d| d.is_empty()).unwrap_or(true) {
            assert!(matches!(
                DeckLinkOutput::open(c, 1920, 1080, (25, 1)),
                Err(OutputError::Unsupported(_))
            ));
            assert!(DeckLinkInput::open(0, 1920, 1080, (25, 1)).is_err());
        }
    }
}
