//! Learning (« Apprendre »): each user's training project, blank or made
//! from an example, to do the lessons on. Hidden from every list, never
//! loaded on a real channel (only on the user's simulation), gone when the
//! lesson ends or a day later.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::{bad, internal, not_found, ApiResult};
use crate::auth::CurrentUser;
use crate::state::{now_ms, Shared};

/// A training project left this long (ms) goes at the next start.
const KEPT_MS: i64 = 24 * 3600 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Training {
    project: String,
    at: i64,
}

fn path_of(dir: &Path) -> PathBuf {
    dir.join("learn.json")
}

/// The training projects, by user.
fn read(dir: &Path) -> BTreeMap<String, Training> {
    std::fs::read(path_of(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write(dir: &Path, all: &BTreeMap<String, Training>) -> std::io::Result<()> {
    let path = path_of(dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(all)?)?;
    std::fs::rename(tmp, path)
}

static WRITING: Mutex<()> = Mutex::new(());

/// The ids of every training project.
pub fn projects(dir: &Path) -> BTreeSet<String> {
    read(dir).into_values().map(|t| t.project).collect()
}

pub fn is_training(dir: &Path, project: &str) -> bool {
    read(dir).values().any(|t| t.project == project)
}

/// Removes the training project of `user` (and those left too long), from
/// the list then from the library.
async fn drop_old(s: &Shared, user: &str) {
    let gone: Vec<String> = {
        let _w = WRITING.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = read(&s.data_dir);
        let now = now_ms();
        let gone: Vec<String> = all
            .iter()
            .filter(|(u, t)| u.as_str() == user || now - t.at > KEPT_MS)
            .map(|(u, _)| u.clone())
            .collect();
        let ids = gone
            .iter()
            .filter_map(|u| all.remove(u).map(|t| t.project))
            .collect();
        if !gone.is_empty() {
            let _ = write(&s.data_dir, &all);
        }
        ids
    };
    for id in gone {
        let _ = crate::api::remove_project(s, &id).await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mine {
    project: Option<String>,
}

/// `GET /api/learn`: the user's training project, if any.
pub async fn get(State(s): State<Shared>, CurrentUser(me): CurrentUser) -> Json<Mine> {
    Json(Mine {
        project: read(&s.data_dir).remove(&me.id).map(|t| t.project),
    })
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    /// Made from this example (`ex-…`); else blank, with one template.
    #[serde(default)]
    example: Option<String>,
}

/// `POST /api/learn` `{example?}`: a new training project for the user (the
/// one before goes).
pub async fn start(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(r): Json<Start>,
) -> ApiResult<Json<Mine>> {
    drop_old(&s, &me.id).await;
    let id = cg_core::new_id();
    let en = me.lang.starts_with("en");
    let mut p = match &r.example {
        Some(ex) => {
            let (p, sources) =
                crate::examples::project(ex, &id).ok_or_else(|| not_found("example"))?;
            crate::api::add_example_sources(&s, sources).await?;
            p
        }
        None => {
            let mut p: cg_core::Project = serde_json::from_value(serde_json::json!({
                "id": id,
                "name": "",
                "width": 1920,
                "height": 1080,
                "frameRate": { "num": 50, "den": 1 },
            }))
            .map_err(internal)?;
            p.zones = cg_core::Zone::defaults();
            if en {
                for z in p.zones.iter_mut().filter(|z| z.id == "full-screen") {
                    z.name = "Full screen".into();
                }
            }
            let zone = p.zones.first().map(|z| z.id.clone()).unwrap_or_default();
            let blank = cg_core::Template::blank_secs(
                if en { "Template 1" } else { "Modèle 1" },
                &zone,
                p.frame_rate.as_f64(),
                1.0,
            );
            let tid = blank.id.clone();
            p.drafts.push(blank);
            p.publish(&tid);
            p.starter = Some(tid);
            p
        }
    };
    p.id = id.clone();
    p.name = if en { "Training" } else { "Entraînement" }.into();
    p.rundown.iter_mut().for_each(|r| r.id = cg_core::new_id());
    {
        let _w = WRITING.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = read(&s.data_dir);
        all.insert(
            me.id.clone(),
            Training {
                project: id.clone(),
                at: now_ms(),
            },
        );
        write(&s.data_dir, &all).map_err(internal)?;
    }
    s.save_project(p).await.map_err(internal)?;
    s.auth.grant_project(&me.id, &id).map_err(internal)?;
    Ok(Json(Mine { project: Some(id) }))
}

/// `DELETE /api/learn`: the user's training project goes.
pub async fn stop(State(s): State<Shared>, CurrentUser(me): CurrentUser) -> StatusCode {
    drop_old(&s, &me.id).await;
    StatusCode::NO_CONTENT
}

/// A training project goes only on its user's simulation.
pub fn check_channel(s: &Shared, channel: &str, project: &str) -> ApiResult<()> {
    if s.channel(channel).is_some() && is_training(&s.data_dir, project) {
        return Err(bad("a training project is never loaded on a channel"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_training_projects_are_kept_by_user() {
        let dir = std::env::temp_dir().join(format!("learn-{}", cg_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(projects(&dir).is_empty());
        let mut all = BTreeMap::new();
        all.insert(
            "u1".to_string(),
            Training {
                project: "p1".into(),
                at: 1,
            },
        );
        write(&dir, &all).unwrap();
        assert!(is_training(&dir, "p1"));
        assert!(!is_training(&dir, "p2"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
