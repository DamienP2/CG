//! Media libraries: files shared by every project (`/assets/<name>`) and the
//! files of one project (`/assets/projects/<id>/<name>`), plus the folders
//! the project list is sorted into.

use std::collections::BTreeMap;
use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::api::{bad, internal, not_found, require, valid_asset_name, visible_project, ApiResult};
use crate::auth::{CurrentUser, Role, User};
use crate::state::{Event, Shared};

/// Largest upload (videos).
const MAX_UPLOAD: usize = 2 * 1024 * 1024 * 1024;

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/media", get(list_shared))
        .route(
            "/api/media/{name}",
            put(put_shared)
                .delete(delete_shared)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD)),
        )
        .route("/api/projects/{id}/media", get(list_project))
        .route(
            "/api/projects/{id}/media/{name}",
            put(put_project)
                .delete(delete_project)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD)),
        )
        .route("/api/folders", get(get_folders).put(put_folders))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub name: String,
    /// URL used in templates.
    pub src: String,
    pub size: u64,
    /// Unix ms.
    pub modified: i64,
    /// image, video, audio, font or other.
    pub kind: &'static str,
}

pub fn kind_of(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" => "image",
        "mp4" | "mov" | "webm" | "mkv" | "m4v" => "video",
        "mp3" | "wav" | "aac" | "m4a" | "ogg" | "flac" => "audio",
        "ttf" | "otf" | "woff" | "woff2" => "font",
        _ => "other",
    }
}

/// Directory of a project's media.
pub fn project_dir(s: &Shared, project: &str) -> PathBuf {
    s.assets_dir().join("projects").join(project)
}

/// URL prefix of a project's media.
pub fn project_prefix(project: &str) -> String {
    format!("/assets/projects/{project}/")
}

async fn list_dir(dir: &FsPath, prefix: &str) -> ApiResult<Vec<MediaFile>> {
    let mut out = Vec::new();
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(d) => d,
        Err(_) => return Ok(out),
    };
    while let Some(e) = rd.next_entry().await.map_err(internal)? {
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // upload in progress
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64);
        out.push(MediaFile {
            src: format!("{prefix}{name}"),
            kind: kind_of(&name),
            size: meta.len(),
            modified,
            name,
        });
    }
    out.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Streams the request body to `dir/name` (through a temporary file).
async fn store(
    s: &Shared,
    dir: &FsPath,
    prefix: &str,
    name: &str,
    body: Body,
) -> ApiResult<Json<MediaFile>> {
    if !valid_asset_name(name) {
        return Err(bad("invalid file name (letters, digits, . - _)"));
    }
    tokio::fs::create_dir_all(dir).await.map_err(internal)?;
    let tmp = dir.join(format!(".{name}.part"));
    let mut f = tokio::fs::File::create(&tmp).await.map_err(internal)?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(bad(e));
            }
        };
        f.write_all(&chunk).await.map_err(internal)?;
    }
    f.flush().await.map_err(internal)?;
    drop(f);
    tokio::fs::rename(&tmp, dir.join(name))
        .await
        .map_err(internal)?;
    s.renderer
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .invalidate_assets();
    list_dir(dir, prefix)
        .await?
        .into_iter()
        .find(|m| m.name == name)
        .map(Json)
        .ok_or_else(|| internal("upload lost"))
}

async fn remove(s: &Shared, dir: &FsPath, name: &str) -> ApiResult<StatusCode> {
    if !valid_asset_name(name) {
        return Err(bad("invalid file name"));
    }
    match tokio::fs::remove_file(dir.join(name)).await {
        Ok(()) => {
            s.renderer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .invalidate_assets();
            Ok(StatusCode::NO_CONTENT)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(not_found("file")),
        Err(e) => Err(internal(e)),
    }
}

fn can_upload(me: &User) -> bool {
    // Operators upload pictures for image fields too.
    me.role != Role::Viewer
}

async fn list_shared(
    State(s): State<Shared>,
    CurrentUser(_): CurrentUser,
) -> ApiResult<Json<Vec<MediaFile>>> {
    list_dir(&s.assets_dir(), "/assets/").await.map(Json)
}

async fn put_shared(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(name): Path<String>,
    body: Body,
) -> ApiResult<Json<MediaFile>> {
    require(can_upload(&me))?;
    store(&s, &s.assets_dir(), "/assets/", &name, body).await
}

async fn delete_shared(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    require(me.can_create_projects())?;
    remove(&s, &s.assets_dir(), &name).await
}

async fn list_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<MediaFile>>> {
    visible_project(&s, &me, &id).await?;
    list_dir(&project_dir(&s, &id), &project_prefix(&id))
        .await
        .map(Json)
}

async fn put_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((id, name)): Path<(String, String)>,
    body: Body,
) -> ApiResult<Json<MediaFile>> {
    visible_project(&s, &me, &id).await?;
    require(can_upload(&me))?;
    store(&s, &project_dir(&s, &id), &project_prefix(&id), &name, body).await
}

async fn delete_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((id, name)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    visible_project(&s, &me, &id).await?;
    require(me.can_design(&id))?;
    remove(&s, &project_dir(&s, &id), &name).await
}

// ---------------------------------------------------------------- folders ----

/// Folders of the project list (one level), and the folder of each project.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folders {
    #[serde(default)]
    pub folders: Vec<String>,
    /// Project id → folder name. Projects not listed are at the top level.
    #[serde(default)]
    pub assign: BTreeMap<String, String>,
}

static FOLDERS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn folders_file(s: &Shared) -> PathBuf {
    s.data_dir.join("folders.json")
}

pub async fn load_folders(s: &Shared) -> Folders {
    tokio::fs::read(folders_file(s))
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

async fn get_folders(State(s): State<Shared>, CurrentUser(_): CurrentUser) -> Json<Folders> {
    Json(load_folders(&s).await)
}

async fn put_folders(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(mut f): Json<Folders>,
) -> ApiResult<Json<Folders>> {
    require(me.can_create_projects())?;
    let _guard = FOLDERS.lock().await;
    let mut names = Vec::new();
    for n in f.folders.iter().map(|n| n.trim()) {
        if n.is_empty() || n.len() > 80 {
            return Err(bad("a folder name has 1 to 80 characters"));
        }
        if !names.iter().any(|x: &String| x == n) {
            names.push(n.to_string());
        }
    }
    f.folders = names;
    // Keep the folders of projects this user cannot see.
    let old = load_folders(&s).await;
    let mut assign: BTreeMap<String, String> = old
        .assign
        .into_iter()
        .filter(|(p, _)| !me.sees_project(p))
        .collect();
    assign.extend(f.assign.into_iter().filter(|(p, _)| me.sees_project(p)));
    assign.retain(|_, folder| f.folders.contains(folder));
    f.assign = assign;
    let json = serde_json::to_vec_pretty(&f).map_err(internal)?;
    tokio::fs::write(folders_file(&s), json)
        .await
        .map_err(internal)?;
    let _ = s.events.send(Event::Folders { folders: f.clone() });
    Ok(Json(f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of("a.PNG"), "image");
        assert_eq!(kind_of("clip.mov"), "video");
        assert_eq!(kind_of("Inter.woff2"), "font");
        assert_eq!(kind_of("readme"), "other");
    }
}
