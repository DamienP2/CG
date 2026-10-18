//! Counter: settings, operator state and actions.
//! Drawn by `cg-render/src/wid/counter.rs` and `web/src/widgets/counter.tsx` (keep in sync).

use serde::{Deserialize, Serialize};

use super::ActCtx;
use crate::model::Layer;

/// Settings of the widget, flattened into the layer's JSON (every field
/// has a default so older projects still load).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {}

/// What the operator changes on air (kept per layer of the graphic on air).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {}

/// Applies an operator action (`op`, with its `args`) to the state.
pub fn act(
    _layer: &Layer,
    _st: &mut State,
    op: &str,
    _args: &serde_json::Value,
    _ctx: &ActCtx,
) -> Result<(), String> {
    Err(format!("unknown action `{op}`"))
}
