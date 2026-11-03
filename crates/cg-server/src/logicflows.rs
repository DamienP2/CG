//! Library › Logic: the flows of logic shared by every project, and each
//! project's own (nodes, wires and frames saved from the Logic canvas).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cg_core::LogicFlow;
use serde::Deserialize;

use crate::api::{bad, internal, require, visible_project, ApiResult};
use crate::auth::CurrentUser;
use crate::state::Shared;

fn file(s: &Shared) -> std::path::PathBuf {
    s.data_dir.join("logic-flows.json")
}

/// The shared flows (none at first).
pub async fn load(s: &Shared) -> Vec<LogicFlow> {
    match tokio::fs::read(file(s)).await {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub async fn list(State(s): State<Shared>, CurrentUser(_me): CurrentUser) -> Json<Vec<LogicFlow>> {
    Json(load(&s).await)
}

fn check(flows: &[LogicFlow]) -> ApiResult<()> {
    for f in flows {
        if f.id.trim().is_empty() || !f.clip.is_object() {
            return Err(bad(format!("invalid flow {:?}", f.name)));
        }
    }
    Ok(())
}

/// Replaces the shared flows.
pub async fn put(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(flows): Json<Vec<LogicFlow>>,
) -> ApiResult<StatusCode> {
    require(me.can_create_projects())?;
    check(&flows)?;
    let _edit = s.edits.lock().await;
    let bytes = serde_json::to_vec_pretty(&flows).map_err(internal)?;
    tokio::fs::write(file(&s), bytes).await.map_err(internal)?;
    s.changed("logic-flows");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ProjectFlows {
    flows: Vec<LogicFlow>,
}

/// Replaces the project's own flows.
pub async fn put_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<ProjectFlows>,
) -> ApiResult<StatusCode> {
    require(me.can_design(&id))?;
    check(&body.flows)?;
    let _edit = s.edits.lock().await;
    let mut p = (*visible_project(&s, &me, &id).await?).clone();
    p.logic_flows = body.flows;
    s.save_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
