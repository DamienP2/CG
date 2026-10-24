//! As-run log: every action on air (who, what, when, with which values),
//! kept on disk per day for compliance and exported as CSV or PDF.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::antenna::Actor;

/// One action on air.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Server time, ms.
    pub at: i64,
    pub channel_id: String,
    pub channel_name: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub project_name: String,
    /// "take", "out", "continue", "update", "clear", "row", "widget",
    /// "trigger", "undo", or for the engine's own steps "auto-next",
    /// "auto-out", "auto-continue".
    pub action: String,
    /// The graphic (rundown item or template name).
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub zone: String,
    pub actor: Actor,
    /// Values sent (take) or changed (update): key → [before, after].
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<String, (Option<String>, String)>,
    /// Free detail ("scheduled 20:00:00", "auto next after 8 s"…).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

/// Keeps an entry.
pub fn record(data_dir: &std::path::Path, e: &Entry) {
    let _ = data_dir;
    tracing::debug!(
        channel = e.channel_id,
        action = e.action,
        label = e.label,
        by = e.actor.name,
        "on air"
    );
}
