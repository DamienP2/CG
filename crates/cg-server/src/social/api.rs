//! `/api/social/…`: the connections (main menu › Data), their messages, and
//! the webhooks the platforms call.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::{webhooks, Message, Platform, SocialSource, SourceInfo};
use crate::api::{bad, internal, not_found, require, ApiResult};
use crate::auth::CurrentUser;
use crate::library::valid_id;
use crate::state::Shared;

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/social/sources", get(list))
        .route(
            "/api/social/sources/{id}",
            put(put_source).delete(delete_source),
        )
        .route("/api/social/sources/{id}/messages", get(messages))
        .route(
            "/api/social/hook/{id}",
            get(webhooks::hook_get).post(webhooks::hook_post),
        )
}

/// A connection as listed: with its status and the projects following it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    #[serde(flatten)]
    pub info: SourceInfo,
    pub projects: usize,
}

#[derive(Deserialize)]
struct Followed {
    #[serde(default)]
    sources: Vec<String>,
}

/// How many projects follow each connection (`<data>/social/projects/*.json`).
fn followers(s: &Shared) -> std::collections::HashMap<String, usize> {
    let mut out = std::collections::HashMap::new();
    let Ok(rd) = std::fs::read_dir(s.social.dir().join("projects")) else {
        return out;
    };
    for e in rd.flatten() {
        let f = std::fs::read(e.path())
            .ok()
            .and_then(|b| serde_json::from_slice::<Followed>(&b).ok());
        for id in f.map(|f| f.sources).unwrap_or_default() {
            *out.entry(id).or_default() += 1;
        }
    }
    out
}

fn listed(s: &Shared) -> Vec<Listed> {
    let follow = followers(s);
    s.social
        .list()
        .into_iter()
        .map(|info| Listed {
            projects: follow.get(&info.source.id).copied().unwrap_or(0),
            info,
        })
        .collect()
}

/// Any signed-in user.
async fn list(State(s): State<Shared>, CurrentUser(_): CurrentUser) -> Json<Vec<Listed>> {
    Json(listed(&s))
}

/// Calls the platform makes (`hookToken`: the token of its address).
fn has_hook(p: Platform) -> bool {
    matches!(p, Platform::Tiktok | Platform::Whatsapp | Platform::Sms)
}

/// Creates or replaces a connection (those who create projects).
async fn put_source(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(mut src): Json<SocialSource>,
) -> ApiResult<Json<Listed>> {
    require(me.can_create_projects())?;
    if !valid_id(&id) {
        return Err(bad("invalid id"));
    }
    src.id = id.clone();
    src.name = src.name.trim().to_string();
    if src.name.is_empty() {
        return Err(bad("a connection needs a name"));
    }
    src.settings.retain(|_, v| !v.trim().is_empty());
    if has_hook(src.platform) && !src.settings.contains_key("hookToken") {
        let old = s
            .social
            .get(&id)
            .and_then(|o| o.settings.get("hookToken").cloned());
        let token = old.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        src.settings.insert("hookToken".into(), token);
    }
    s.social.put(src).map_err(internal)?;
    s.changed("social");
    listed(&s)
        .into_iter()
        .find(|l| l.info.source.id == id)
        .map(Json)
        .ok_or_else(|| internal("lost"))
}

async fn delete_source(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    require(me.can_create_projects())?;
    if !s.social.delete(&id).map_err(internal)? {
        return Err(not_found("connection"));
    }
    s.changed("social");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MessagesQuery {
    limit: Option<usize>,
}

/// The last messages of a connection, newest first.
async fn messages(
    State(s): State<Shared>,
    CurrentUser(_): CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> ApiResult<Json<Vec<Message>>> {
    if s.social.get(&id).is_none() {
        return Err(not_found("connection"));
    }
    let mut list = s.social.recent(&id);
    list.reverse();
    list.truncate(q.limit.unwrap_or(100).min(super::RECENT));
    Ok(Json(list))
}
