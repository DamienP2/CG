//! Templates kept in the library: shared by every project, or kept with one
//! project. Each is a copy (adding one to a project copies it again): the
//! library changing never changes a graphic on air.
//!
//! `<data>/template-library/<id>.json` and its thumbnail `<id>.png`. A
//! shared one takes along the media of its project it uses (copied into the
//! shared library), so it works in any project.

use std::path::{Path as FsPath, PathBuf};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use cg_core::Template;
use serde::{Deserialize, Serialize};

use crate::api::{internal, not_found, require, valid_asset_name, visible_project, ApiResult};
use crate::auth::{CurrentUser, User};
use crate::state::Shared;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    /// The project it is kept with ("" = shared by every project).
    #[serde(default)]
    pub project: String,
    /// The project it came from (shown on its card).
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub created: i64,
    /// The size it was designed at.
    pub width: u32,
    pub height: u32,
    pub template: Template,
}

/// An entry without its template (the lists).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub project: String,
    pub from: String,
    pub author: String,
    pub author_name: String,
    pub created: i64,
    pub width: u32,
    pub height: u32,
    pub layers: usize,
}

impl From<&Entry> for Summary {
    fn from(e: &Entry) -> Self {
        Self {
            id: e.id.clone(),
            name: e.name.clone(),
            project: e.project.clone(),
            from: e.from.clone(),
            author: e.author.clone(),
            author_name: e.author_name.clone(),
            created: e.created,
            width: e.width,
            height: e.height,
            layers: e.template.layers.len(),
        }
    }
}

fn dir(s: &Shared) -> PathBuf {
    s.data_dir.join("template-library")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn read(dir: &FsPath, id: &str) -> Option<Entry> {
    if !valid_id(id) {
        return None;
    }
    std::fs::read(dir.join(format!("{id}.json")))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

fn all(dir: &FsPath) -> Vec<Entry> {
    let mut out: Vec<Entry> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|f| {
            let name = f.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            read(dir, id)
        })
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.created));
    out
}

/// The entries kept with a removed project go with it.
pub fn forget_project(s: &Shared, project: &str) {
    let d = dir(s);
    let mut n = 0;
    for e in all(&d).into_iter().filter(|e| e.project == project) {
        let _ = std::fs::remove_file(d.join(format!("{}.json", e.id)));
        let _ = std::fs::remove_file(d.join(format!("{}.png", e.id)));
        n += 1;
    }
    if n > 0 {
        s.changed("template-library");
    }
}

/// Someone sees an entry: shared, or of a project they see.
fn sees(me: &User, e: &Entry) -> bool {
    e.project.is_empty() || me.sees_project(&e.project)
}

/// The media of project `project` a template uses, copied into the shared
/// library (the same file found there is used, another one of the same name
/// gets another name); its addresses changed to theirs.
fn share_media(s: &Shared, project: &str, t: &Template) -> anyhow::Result<(Template, usize)> {
    let prefix = crate::media::project_prefix(project);
    let mut json = serde_json::to_string(t)?;
    let shared = s.assets_dir();
    let own = crate::media::project_dir(s, project);
    let mut copied = 0;
    let mut names: Vec<String> = Vec::new();
    let mut at = 0;
    while let Some(i) = json[at..].find(&prefix) {
        let start = at + i + prefix.len();
        let end = json[start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
            .map_or(json.len(), |n| start + n);
        let name = json[start..end].to_string();
        if valid_asset_name(&name) && !names.contains(&name) {
            names.push(name);
        }
        at = end;
    }
    for name in names {
        let src = own.join(&name);
        let Ok(bytes) = std::fs::read(&src) else {
            continue;
        };
        // The same file already shared: used as it is.
        let (stem, ext) = name
            .rsplit_once('.')
            .map_or((name.as_str(), ""), |(a, b)| (a, b));
        let mut target = name.clone();
        let mut n = 2;
        loop {
            match std::fs::read(shared.join(&target)) {
                Ok(have) if have == bytes => break,
                Ok(_) => {
                    target = if ext.is_empty() {
                        format!("{stem}-{n}")
                    } else {
                        format!("{stem}-{n}.{ext}")
                    };
                    n += 1;
                }
                Err(_) => {
                    std::fs::create_dir_all(&shared)?;
                    std::fs::write(shared.join(&target), &bytes)?;
                    copied += 1;
                    break;
                }
            }
        }
        json = json.replace(&format!("{prefix}{name}\""), &format!("/assets/{target}\""));
        json = json.replace(&format!("{prefix}{name})"), &format!("/assets/{target})"));
    }
    Ok((serde_json::from_str(&json)?, copied))
}

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/template-library", get(list).post(save))
        .route("/api/template-library/{id}", get(one).delete(remove))
        .route("/api/template-library/{id}/thumbnail.png", get(thumbnail))
}

#[derive(Deserialize)]
struct ListQuery {
    /// Also the ones kept with this project.
    #[serde(default)]
    project: String,
}

async fn list(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Query(q): Query<ListQuery>,
) -> Json<Vec<Summary>> {
    let dir = dir(&s);
    let list = tokio::task::spawn_blocking(move || all(&dir))
        .await
        .unwrap_or_default();
    Json(
        list.iter()
            .filter(|e| {
                e.project.is_empty() || (e.project == q.project && me.sees_project(&e.project))
            })
            .map(Summary::from)
            .collect(),
    )
}

async fn one(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Entry>> {
    let e = read(&dir(&s), &id)
        .filter(|e| sees(&me, e))
        .ok_or_else(|| not_found("template"))?;
    Ok(Json(e))
}

async fn thumbnail(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let d = dir(&s);
    read(&d, &id)
        .filter(|e| sees(&me, e))
        .ok_or_else(|| not_found("template"))?;
    let png = std::fs::read(d.join(format!("{id}.png"))).map_err(|_| not_found("thumbnail"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        Bytes::from(png),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveInput {
    project: String,
    template: String,
    #[serde(default)]
    name: String,
    /// In the shared library (else kept with the project).
    #[serde(default)]
    shared: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    entry: Summary,
    /// Media of the project copied into the shared library.
    copied: usize,
}

async fn save(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(i): Json<SaveInput>,
) -> ApiResult<Json<Saved>> {
    require(me.can_design(&i.project))?;
    let p = visible_project(&s, &me, &i.project).await?;
    let t = p
        .draft(&i.template)
        .or(p.template(&i.template))
        .cloned()
        .ok_or_else(|| not_found("template"))?;
    let name = if i.name.trim().is_empty() {
        t.name.clone()
    } else {
        i.name.trim().chars().take(120).collect()
    };
    let st = s.clone();
    let (project, shared) = (i.project.clone(), i.shared);
    let (template, copied) = tokio::task::spawn_blocking(move || {
        if shared {
            share_media(&st, &project, &t)
        } else {
            Ok((t, 0))
        }
    })
    .await
    .map_err(internal)?
    .map_err(internal)?;
    let entry = Entry {
        id: cg_core::new_id(),
        name,
        project: if shared {
            String::new()
        } else {
            i.project.clone()
        },
        from: p.name.clone(),
        author: me.id.clone(),
        author_name: if me.display_name.is_empty() {
            me.username.clone()
        } else {
            me.display_name.clone()
        },
        created: crate::state::now_ms(),
        width: p.width,
        height: p.height,
        template,
    };
    let d = dir(&s);
    std::fs::create_dir_all(&d).map_err(internal)?;
    // Its picture, as on air (in the project it comes from).
    let st = s.clone();
    let (pr, tpl) = (p.clone(), entry.template.clone());
    let png = tokio::task::spawn_blocking(move || {
        let data = tpl.default_data();
        let frame = {
            let mut r = st.renderer.lock().unwrap_or_else(|e| e.into_inner());
            r.render_template_scaled(
                &pr,
                &tpl,
                cg_core::MAIN_FORMAT,
                tpl.hold_frame(),
                &data,
                480,
            )
        };
        cg_render::pool::busy();
        frame.to_png()
    })
    .await
    .map_err(internal)?;
    std::fs::write(d.join(format!("{}.png", entry.id)), png).map_err(internal)?;
    std::fs::write(
        d.join(format!("{}.json", entry.id)),
        serde_json::to_vec(&entry).map_err(internal)?,
    )
    .map_err(internal)?;
    s.changed("template-library");
    Ok(Json(Saved {
        entry: (&entry).into(),
        copied,
    }))
}

/// Its author, an admin, or (kept with a project) a designer of the project.
async fn remove(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let d = dir(&s);
    let e = read(&d, &id)
        .filter(|e| sees(&me, e))
        .ok_or_else(|| not_found("template"))?;
    require(
        me.is_admin() || e.author == me.id || (!e.project.is_empty() && me.can_design(&e.project)),
    )?;
    std::fs::remove_file(d.join(format!("{id}.json"))).map_err(internal)?;
    let _ = std::fs::remove_file(d.join(format!("{id}.png")));
    s.changed("template-library");
    Ok(StatusCode::NO_CONTENT)
}
