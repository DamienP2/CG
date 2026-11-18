//! Library › Widgets: the widgets built with the Builder that every project
//! shares (the pre-built ones first), and the hidden project their Builder
//! opens in from the main page.

use std::collections::BTreeMap;

use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cg_core::built::Def;
use cg_core::{FrameRate, Project};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// The shared widgets: the pre-built ones until the first change; a pre-built
/// one shipped since is added (once: a removed one is remembered).
pub async fn load(s: &Shared) -> Vec<Def> {
    let prebuilt: Vec<Def> = serde_json::from_str(PREBUILT).unwrap_or_default();
    let Ok(b) = tokio::fs::read(file(s)).await else {
        return prebuilt;
    };
    let mut defs: Vec<Def> = serde_json::from_slice(&b).unwrap_or_default();
    // A pre-built widget saved before it had a description and a category: they come from Strata.
    for d in &mut defs {
        if let Some(p) = prebuilt.iter().find(|p| p.id == d.id) {
            for k in ["description", "category"] {
                if !d.rest.contains_key(k) {
                    if let Some(v) = p.rest.get(k) {
                        d.rest.insert(k.into(), v.clone());
                    }
                }
            }
        }
    }
    let seen = removed(s).await;
    for d in prebuilt {
        if !defs.iter().any(|x| x.id == d.id) && !seen.contains(&d.id) {
            defs.push(d);
        }
    }
    defs
}

fn removed_file(s: &Shared) -> std::path::PathBuf {
    s.data_dir.join("widgets-removed.json")
}

/// The pre-built widgets removed here (not given back at the next start).
async fn removed(s: &Shared) -> Vec<String> {
    match tokio::fs::read(removed_file(s)).await {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
        Err(_) => Vec::new(),
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
    /// The widgets of each project the user sees (the Widget Builder's gallery).
    projects: Vec<ProjectWidgets>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWidgets {
    id: String,
    name: String,
    widgets: Vec<Def>,
    /// Widget id → the number of the project's templates using it.
    uses: BTreeMap<String, usize>,
    /// The user may change them.
    can_edit: bool,
}

/// The widgets of the projects `me` sees (the host aside), with their templates using them.
async fn project_widgets(s: &Shared, me: &crate::auth::User) -> Vec<ProjectWidgets> {
    let lib = s.library.read().await;
    lib.list()
        .filter(|p| p.id != HOST && me.sees_project(&p.id) && !p.widgets.is_empty())
        .map(|p| {
            let mut uses: BTreeMap<String, usize> = BTreeMap::new();
            for t in p.templates.iter().chain(&p.drafts) {
                let mut ids: Vec<&str> = t
                    .layers
                    .iter()
                    .filter_map(|l| l.widget.as_ref().map(|w| w.def.as_str()))
                    .collect();
                ids.sort_unstable();
                ids.dedup();
                for id in ids {
                    *uses.entry(id.to_string()).or_default() += 1;
                }
            }
            ProjectWidgets {
                id: p.id.clone(),
                name: p.name.clone(),
                widgets: p.widgets.clone(),
                uses,
                can_edit: me.can_design(&p.id),
            }
        })
        .collect()
}

pub async fn list(State(s): State<Shared>, CurrentUser(me): CurrentUser) -> Json<Listing> {
    Json(Listing {
        widgets: load(&s).await,
        uses: uses(&s).await,
        projects: project_widgets(&s, &me).await,
    })
}

// ------------------------------------------------------------------ versions

/// Versions kept per widget.
const KEPT_VERSIONS: usize = 30;

fn versions_dir(s: &Shared, wid: &str) -> Option<PathBuf> {
    crate::library::valid_id(wid).then(|| s.data_dir.join("widget-versions").join(wid))
}

/// A widget's published version (each Publish adds one).
pub fn rev_of(d: &Def) -> u64 {
    d.rest.get("rev").and_then(Value::as_u64).unwrap_or(0)
}

/// A version kept: when, by whom, and the widget as published then.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    rev: u64,
    /// Unix milliseconds (0: before versions were kept).
    at: i64,
    by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    def: Option<Def>,
}

/// The widget as published (without the draft its Builder keeps).
fn published(d: &Def) -> Def {
    let mut d = d.clone();
    d.rest.remove("draft");
    d
}

/// A widget saved: when its version went up (a Publish), the new version is
/// kept, and the one before too if it never was. The oldest go beyond [`KEPT_VERSIONS`].
pub async fn keep_version(s: &Shared, before: Option<&Def>, after: &Def, by: &str) {
    let rev = rev_of(after);
    if rev == 0 || before.is_some_and(|b| rev_of(b) >= rev) {
        return;
    }
    let Some(dir) = versions_dir(s, &after.id) else {
        return;
    };
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return;
    }
    let write = |d: &Def, at: i64, by: &str| {
        let v = Version {
            rev: rev_of(d),
            at,
            by: by.to_string(),
            def: Some(published(d)),
        };
        (
            dir.join(format!("{}.json", v.rev)),
            serde_json::to_vec(&v).unwrap_or_default(),
        )
    };
    if let Some(b) = before.filter(|b| rev_of(b) > 0) {
        let (path, bytes) = write(b, 0, "");
        if !path.exists() {
            let _ = tokio::fs::write(path, bytes).await;
        }
    }
    let (path, bytes) = write(after, crate::state::now_ms(), by);
    let _ = tokio::fs::write(path, bytes).await;
    // The oldest out.
    let mut revs = kept_revs(&dir).await;
    revs.sort_unstable_by_key(|r| std::cmp::Reverse(*r));
    for r in revs.into_iter().skip(KEPT_VERSIONS) {
        let _ = tokio::fs::remove_file(dir.join(format!("{r}.json"))).await;
    }
}

async fn kept_revs(dir: &std::path::Path) -> Vec<u64> {
    let mut out = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Some(r) = e
                .file_name()
                .to_str()
                .and_then(|n| n.strip_suffix(".json"))
                .and_then(|n| n.parse().ok())
            {
                out.push(r);
            }
        }
    }
    out
}

/// The user may see the widget `wid`'s versions: a shared one (designers), or one of a project they design.
async fn may_see(s: &Shared, me: &crate::auth::User, wid: &str) -> ApiResult<()> {
    if load(s).await.iter().any(|d| d.id == wid) {
        return require(me.can_create_projects());
    }
    let lib = s.library.read().await;
    let owner = lib.list().find(|p| p.widgets.iter().any(|w| w.id == wid));
    match owner {
        Some(p) => require(me.can_design(&p.id)),
        None => Err(not_found("widget")),
    }
}

/// The versions of a widget kept, the latest first (without their content).
pub async fn versions(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(wid): Path<String>,
) -> ApiResult<Json<Vec<Version>>> {
    may_see(&s, &me, &wid).await?;
    let Some(dir) = versions_dir(&s, &wid) else {
        return Err(not_found("widget"));
    };
    let mut out = Vec::new();
    for r in kept_revs(&dir).await {
        let Ok(b) = tokio::fs::read(dir.join(format!("{r}.json"))).await else {
            continue;
        };
        if let Ok(mut v) = serde_json::from_slice::<Version>(&b) {
            v.def = None;
            out.push(v);
        }
    }
    out.sort_unstable_by_key(|v| std::cmp::Reverse(v.rev));
    Ok(Json(out))
}

/// One kept version of a widget, with its content.
pub async fn version(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((wid, rev)): Path<(String, u64)>,
) -> ApiResult<Json<Version>> {
    may_see(&s, &me, &wid).await?;
    let dir = versions_dir(&s, &wid).ok_or_else(|| not_found("widget"))?;
    let b = tokio::fs::read(dir.join(format!("{rev}.json")))
        .await
        .map_err(|_| not_found("version"))?;
    Ok(Json(serde_json::from_slice(&b).map_err(internal)?))
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
    let before = defs.iter().find(|d| d.id == wid).cloned();
    keep_version(&s, before.as_ref(), &def, &me.username).await;
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
    let prebuilt: Vec<Def> = serde_json::from_str(PREBUILT).unwrap_or_default();
    if prebuilt.iter().any(|d| d.id == wid) {
        let mut gone = removed(&s).await;
        gone.push(wid);
        let bytes = serde_json::to_vec(&gone).map_err(internal)?;
        tokio::fs::write(removed_file(&s), bytes)
            .await
            .map_err(internal)?;
    }
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
        for id in [
            "scoreboard",
            "ticker",
            "credits",
            "socialbadge",
            "socialwall",
        ] {
            assert!(defs.iter().any(|d| d.id == id), "{id}");
        }
        // Their elements read as layers (lists, rolls, per-row rules).
        for d in &defs {
            let layers = d.rest.get("layers").cloned().unwrap_or_default();
            let _: Vec<cg_core::Layer> = serde_json::from_value(layers).unwrap();
        }
    }
}
