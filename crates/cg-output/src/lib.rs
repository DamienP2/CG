//! Baseband outputs fed by the software renderer.
//!
//! The HTML5 output does not go through here: it is a browser page driven by
//! the server over WebSocket (see `cg-server`), rendering the same scene with
//! the web engine, which is what OBS / vMix / CasparCG browser sources expect.

pub mod colorspace;
pub mod ffmpeg;
pub mod mov;
pub mod ndi;
pub mod sdi;
pub mod st2110;
pub mod stream;

use std::sync::Arc;
use std::time::SystemTime;

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
    /// One frame per tick of the channel clock; `at` is that tick (the same
    /// frame comes again, with a later `at`, when the next one is late).
    fn push(&mut self, frame: &Arc<Frame>, at: SystemTime) -> Result<(), OutputError>;
    /// The process doing the work, when it is another one (ffmpeg), for its load.
    fn process(&self) -> Option<u32> {
        None
    }
}
