//! Baseband outputs fed by the software renderer.
//!
//! The HTML5 output does not go through here: it is a browser page driven by
//! the server over WebSocket (see `cg-server`), rendering the same scene with
//! the web engine, which is what OBS / vMix / CasparCG browser sources expect.

pub mod colorspace;
pub mod mov;
pub mod ndi;
pub mod sdi;
pub mod st2110;

use cg_render::Frame;

#[derive(Debug, thiserror::Error)]
pub enum OutputError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("output not supported: {0}")]
    Unsupported(String),
    #[error("frame dropped (sender busy)")]
    Dropped,
    #[error("output closed")]
    Closed,
}

/// Anything that consumes rendered frames at the channel frame rate.
pub trait OutputSink: Send {
    fn name(&self) -> &str;
    fn push(&mut self, frame: &Frame) -> Result<(), OutputError>;
}
