//! The widgets of the spec, one module each: settings (`Config`, flattened
//! into the layer), operator state (`State`) and the actions that change it.
//!
//! Operator actions are a pure function of (layer, state, action, time): the
//! server applies them to the graphic on air (`Command::Act`) and the
//! Designer asks the server to apply them to its own try-out state, so the
//! logic lives here only. Both renderers read the state as JSON.

pub mod chart;
pub mod counter;
pub mod credits;
pub mod ellipse;
pub mod image;
pub mod map;
pub mod pen;
pub mod polygon;
pub mod progress;
pub mod qrcode;
pub mod quad;
pub mod scoreboard;
pub mod shape;
pub mod table;
pub mod text;
pub mod ticker;
pub mod timer;
pub mod typewriter;
pub mod web;

use serde_json::Value;

use crate::anim::Data;
use crate::model::{Layer, LayerKind};

/// Inputs of an action besides its arguments.
#[derive(Debug, Clone, Copy)]
pub struct ActCtx<'a> {
    /// Wall-clock time, Unix milliseconds (timestamp-based widgets never drift).
    pub now_ms: i64,
    /// Seconds the graphic has been on air.
    pub age_secs: f64,
    /// Values of the graphic.
    pub data: &'a Data,
}

/// Name of the widget module drawing this layer, if it is one of the spec's.
pub fn widget_id(kind: &LayerKind) -> Option<&'static str> {
    Some(match kind {
        LayerKind::Rect { .. } => "quad",
        LayerKind::Polygon { .. } => "polygon",
        LayerKind::Ellipse { .. } => "ellipse",
        LayerKind::Text { .. } => "text",
        LayerKind::Image { .. } => "image",
        LayerKind::Pen { .. } => "pen",
        LayerKind::Clock { .. } => "timer",
        LayerKind::Table { .. } => "table",
        LayerKind::Ticker { .. } => "ticker",
        LayerKind::Credits { .. } => "credits",
        LayerKind::Typewriter { .. } => "typewriter",
        LayerKind::Counter { .. } => "counter",
        LayerKind::Progress { .. } => "progress",
        LayerKind::Chart { .. } => "chart",
        LayerKind::Map { .. } => "map",
        LayerKind::QrCode { .. } => "qrcode",
        LayerKind::Scoreboard { .. } => "scoreboard",
        LayerKind::Web { .. } => "web",
        _ => return None,
    })
}

/// Applies `op` to the layer's state (`Null` = the widget's default state).
pub fn act(
    layer: &Layer,
    state: &mut Value,
    op: &str,
    args: &Value,
    ctx: &ActCtx,
) -> Result<(), String> {
    macro_rules! go {
        ($m:ident) => {{
            let mut st: $m::State = serde_json::from_value(state.clone()).unwrap_or_default();
            $m::act(layer, &mut st, op, args, ctx)?;
            *state = serde_json::to_value(st).map_err(|e| e.to_string())?;
            Ok(())
        }};
    }
    match &layer.kind {
        LayerKind::Rect { .. } => go!(quad),
        LayerKind::Polygon { .. } => go!(polygon),
        LayerKind::Ellipse { .. } => go!(ellipse),
        LayerKind::Text { .. } => go!(text),
        LayerKind::Image { .. } => go!(image),
        LayerKind::Pen { .. } => go!(pen),
        LayerKind::Clock { .. } => go!(timer),
        LayerKind::Table { .. } => go!(table),
        LayerKind::Ticker { .. } => go!(ticker),
        LayerKind::Credits { .. } => go!(credits),
        LayerKind::Typewriter { .. } => go!(typewriter),
        LayerKind::Counter { .. } => go!(counter),
        LayerKind::Progress { .. } => go!(progress),
        LayerKind::Chart { .. } => go!(chart),
        LayerKind::Map { .. } => go!(map),
        LayerKind::QrCode { .. } => go!(qrcode),
        LayerKind::Scoreboard { .. } => go!(scoreboard),
        LayerKind::Web { .. } => go!(web),
        _ => Err("this layer has no operator actions".into()),
    }
}
