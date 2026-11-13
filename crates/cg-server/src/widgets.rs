//! Library › Widgets: the widgets built with the Builder that every project
//! shares (the pre-built ones first), and the hidden project their Builder
//! opens in from the main page.

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cg_core::built::Def;
use cg_core::{FrameRate, Project};
use serde::Serialize;

use crate::api::{bad, internal, not_found, require, visible_project, ApiResult};
use crate::auth::CurrentUser;
use crate::state::Shared;

/// The project the Builder of a shared widget opens in from the main page:
/// in no list, seen by the designers who see every project.
pub const HOST: &str = "widgets";

/// The widgets shipped with Strata (made with the Builder).
const PREBUILT: &str = include_str!("widgets/prebuilt.json");

fn file(s: &Shared) -> std::path::PathBuf {
    s.data_dir.join("widgets.json")
}

/// The shared widgets: the pre-built ones until the first change.
pub async fn load(s: &Shared) -> Vec<Def> {
    match tokio::fs::read(file(s)).await {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
        Err(_) => serde_json::from_str(PREBUILT).unwrap_or_default(),
    }
}

async fn save(s: &Shared, defs: &[Def]) -> ApiResult<()> {
    let bytes = serde_json::to_vec_pretty(defs).map_err(internal)?;
    tokio::fs::write(file(s), bytes).await.map_err(internal)?;
    s.changed("widgets");
    Ok(())
}

/// The projects (the host aside) whose templates use each widget.
async fn uses(s: &Shared) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    let lib = s.library.read().await;
    for p in lib.list().filter(|p| p.id != HOST) {
        let mut ids: Vec<&str> = p
            .templates
            .iter()
            .chain(&p.drafts)
            .flat_map(|t| t.layers.iter())
            .filter_map(|l| l.widget.as_ref().map(|w| w.def.as_str()))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            *out.entry(id.to_string()).or_default() += 1;
        }
    }
    out
}

#[derive(Serialize)]
pub struct Listing {
    widgets: Vec<Def>,
    /// Widget id → the number of projects using it.
    uses: BTreeMap<String, usize>,
}

pub async fn list(State(s): State<Shared>, CurrentUser(_me): CurrentUser) -> Json<Listing> {
    Json(Listing {
        widgets: load(&s).await,
        uses: uses(&s).await,
    })
}

/// Adds or replaces the shared widget `wid`.
pub async fn put(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(wid): Path<String>,
    Json(def): Json<Def>,
) -> ApiResult<StatusCode> {
    require(me.can_edit_shared())?;
    if def.id != wid {
        return Err(bad("the widget id does not match the address"));
    }
    if def.name.trim().is_empty() {
        return Err(bad("a widget needs a name"));
    }
    let _edit = s.edits.lock().await;
    let mut defs = load(&s).await;
    match defs.iter_mut().find(|d| d.id == wid) {
        Some(d) => *d = def,
        None => defs.push(def),
    }
    save(&s, &defs).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes a shared widget no project uses any more.
pub async fn delete(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(wid): Path<String>,
) -> ApiResult<StatusCode> {
    require(me.can_edit_shared())?;
    let _edit = s.edits.lock().await;
    if let Some(n) = uses(&s).await.get(&wid) {
        return Err(bad(format!("{n} project(s) still use this widget")));
    }
    let mut defs = load(&s).await;
    let before = defs.len();
    defs.retain(|d| d.id != wid);
    if defs.len() == before {
        return Err(not_found("widget"));
    }
    save(&s, &defs).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Moves the project's widget `wid` to the shared ones (every project can add it; the templates
/// using it keep it).
pub async fn share(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((id, wid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    require(me.can_edit_shared() && me.can_design(&id))?;
    let _edit = s.edits.lock().await;
    let mut p = (*visible_project(&s, &me, &id).await?).clone();
    let at = p
        .widgets
        .iter()
        .position(|w| w.id == wid)
        .ok_or_else(|| not_found("widget"))?;
    let def = p.widgets.remove(at);
    let mut defs = load(&s).await;
    defs.retain(|d| d.id != wid);
    defs.push(def);
    save(&s, &defs).await?;
    s.save_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct Host {
    id: &'static str,
}

/// The project the Builder of shared widgets opens in (made at first use).
pub async fn host(State(s): State<Shared>, CurrentUser(me): CurrentUser) -> ApiResult<Json<Host>> {
    require(me.can_edit_shared())?;
    let _edit = s.edits.lock().await;
    if s.project(HOST).await.is_none() {
        s.save_project(Project {
            pending: None,
            guides: Default::default(),
            design_order: Vec::new(),
            language: "fr".into(),
            template_secs: None,
            colors: Vec::new(),
            logic_flows: Vec::new(),
            widgets: Vec::new(),
            logic: Default::default(),
            id: HOST.into(),
            name: "Widgets".into(),
            description: String::new(),
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::new(50, 1),
            templates: Vec::new(),
            rundown: Vec::new(),
            zones: cg_core::Zone::defaults(),
            playlists: Vec::new(),
            formats: Vec::new(),
            drafts: Vec::new(),
            starter: None,
        })
        .await
        .map_err(internal)?;
    }
    Ok(Json(Host { id: HOST }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PressQuery {
    /// The widget's Logic as placed ([`cg_core::built::control_trigger`]s).
    logic: cg_core::logic::Logic,
    /// The widget's folder id in the template.
    widget: String,
    control: String,
    /// What was typed in the field pressed (`$value`).
    #[serde(default)]
    value: String,
    #[serde(default)]
    data: BTreeMap<String, String>,
    /// The widgets' states (Undo), by layer id.
    #[serde(default)]
    states: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize)]
pub struct Forwarded {
    layer: String,
    op: String,
    args: serde_json::Value,
}

#[derive(Serialize)]
pub struct Pressed {
    /// The values changed.
    set: BTreeMap<String, String>,
    states: BTreeMap<String, serde_json::Value>,
    /// What goes to its elements (a Temps started…).
    forward: Vec<Forwarded>,
}

/// A control of a widget pressed outside the air (the Operator's preview,
/// the Builder's try-out): its Logic run as on air.
pub async fn press(
    CurrentUser(_me): CurrentUser,
    Json(q): Json<PressQuery>,
) -> ApiResult<Json<Pressed>> {
    let mut states = q.states;
    let (set, forward) = cg_core::built::press(
        &q.logic,
        &q.widget,
        &q.control,
        &q.value,
        &q.data,
        &mut states,
    )
    .map_err(bad)?;
    Ok(Json(Pressed {
        set,
        states,
        forward: forward
            .into_iter()
            .map(|f| Forwarded {
                layer: f.layer,
                op: f.op,
                args: f.args,
            })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prebuilt_widgets_read() {
        let defs: Vec<Def> = serde_json::from_str(PREBUILT).unwrap();
        assert!(defs
            .iter()
            .any(|d| d.id == "scoreboard" && !d.controls.is_empty()));
    }
}
