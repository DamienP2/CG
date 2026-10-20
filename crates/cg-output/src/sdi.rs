//! SDI output through Blackmagic DeckLink cards (fill + key).
//!
//! The DeckLink SDK is a C++/COM API distributed by Blackmagic under its own
//! licence, so it is not vendored here. Building with `--features decklink`
//! is reserved for the FFI bridge (a thin C++ shim exposing
//! `IDeckLinkOutput::ScheduleVideoFrame` with an internal keyer configured
//! for external key/fill). Without the feature, opening a device returns
//! `OutputError::Unsupported` so the rest of the server keeps working.
//!
//! Frames are handed over as BGRA 8-bit premultiplied (bmdFormat8BitBGRA),
//! which DeckLink converts to 10-bit YUV fill + key on the card.

use cg_render::Frame;
use serde::{Deserialize, Serialize};

use crate::{OutputError, OutputSink};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdiConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// DeckLink device index (as listed by Desktop Video).
    pub device: u32,
    /// Use the card's external keyer (fill on SDI A, key on SDI B); off:
    /// the card's internal keyer over its SDI input.
    #[serde(default = "yes")]
    pub external_key: bool,
    /// Fill only, no key.
    #[serde(default)]
    pub fill_only: bool,
    /// Lock to the card's reference input.
    #[serde(default)]
    pub genlock: bool,
}

fn yes() -> bool {
    true
}

pub struct DeckLinkOutput {
    config: SdiConfig,
    bgra: Vec<u8>,
}

impl DeckLinkOutput {
    pub fn open(config: SdiConfig) -> Result<Self, OutputError> {
        if cfg!(feature = "decklink") {
            // FFI bridge goes here (see module docs).
            Err(OutputError::Unsupported(
                "DeckLink FFI bridge not built yet".into(),
            ))
        } else {
            let _ = &config;
            Err(OutputError::Unsupported(
                "DeckLink support is not built into this server (`decklink` feature)".into(),
            ))
        }
    }

    /// RGBA → BGRA swizzle, the native DeckLink pixel format.
    pub fn to_bgra(frame: &Frame, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(frame.data.len());
        for px in frame.data.as_chunks::<4>().0 {
            out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
}

impl OutputSink for DeckLinkOutput {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn push(
        &mut self,
        frame: &std::sync::Arc<Frame>,
        _at: std::time::SystemTime,
    ) -> Result<(), OutputError> {
        let mut buf = std::mem::take(&mut self.bgra);
        Self::to_bgra(frame, &mut buf);
        self.bgra = buf;
        Err(OutputError::Unsupported(
            "DeckLink output not available".into(),
        ))
    }
}
