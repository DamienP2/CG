//! REST + WebSocket API used by the web app and by automation systems
//! (Companion / Stream Deck, newsroom MOS gateways, sports data feeds...).
//! Every route checks the caller's role and project / channel scope.

use std::collections::BTreeMap;
use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use cg_core::{Command, FrameRate, Project, RundownItem, Template};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::auth::{self, CurrentUser, MaybeUser, PublicUser, Role, User, UserInput};
use crate::config::ServerConfig;
use crate::library::{valid_id, ProjectSummary};
use crate::state::{now_ms, ChannelInfo, ClientMessage, Event, Shared};

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/auth/state", get(auth_state))
        .route("/api/auth/setup", post(auth_setup))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", put(update_user).delete(delete_user))
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/import", post(import_project))
        .route(
            "/api/projects/{id}",
            get(get_project)
                .put(put_project_meta)
                .delete(delete_project),
        )
        .route("/api/projects/{id}/export", get(export_project))
        .route("/api/projects/{id}/rundown", put(put_rundown))
        .route("/api/projects/{id}/zones", put(put_zones))
        .route(
            "/api/projects/{id}/templates/{tid}",
            put(put_template).delete(delete_template),
        )
        .route(
            "/api/projects/{id}/templates/{tid}/thumbnail.png",
            get(template_thumbnail),
        )
        .route("/api/channels", get(list_channels))
        .route("/api/channels/{id}/state", get(channel_state))
        .route("/api/channels/{id}/project", put(load_project))
        .route("/api/channels/{id}/command", post(channel_command))
        .route("/api/channels/{id}/preview.png", get(channel_preview))
        .route("/api/channels/{id}/outputs/{name}/{essence}", get(get_sdp))
        .route("/api/assets", get(list_assets))
        .route("/api/assets/{name}", put(put_asset))
        .route("/api/health", get(health))
        .route("/api/qr", get(qr))
        .route("/api/system", get(get_system))
        .route("/api/system/config", put(put_system_config))
        .route("/api/system/restart", post(post_restart))
        .route("/api/system/update", get(update_info))
        .route("/api/system/update/settings", put(update_settings))
        .route("/api/system/update/check", post(update_check))
        .route("/api/system/update/install", post(update_install))
        .route(
            "/api/system/update/upload",
            post(update_upload).layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route("/api/system/update/rollback", post(update_rollback))
        .route("/output", get(output_redirect))
        .route("/ws", get(ws_upgrade))
}

type ApiResult<T> = Result<T, (StatusCode, String)>;

fn bad(e: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, e.to_string())
}
fn internal(e: impl ToString) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}
fn not_found(what: &str) -> (StatusCode, String) {
    (StatusCode::NOT_FOUND, format!("no such {what}"))
}
fn forbidden() -> (StatusCode, String) {
    (
        StatusCode::FORBIDDEN,
        "you do not have the rights for this".into(),
    )
}
fn require(ok: bool) -> ApiResult<()> {
    if ok {
        Ok(())
    } else {
        Err(forbidden())
    }
}

// ------------------------------------------------------------------ auth ----

fn session_cookie(token: &str, max_age: i64) -> String {
    format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}",
        auth::COOKIE
    )
}

fn server_timezone(s: &Shared) -> String {
    if !s.config.timezone.trim().is_empty() {
        return s.config.timezone.trim().to_string();
    }
    jiff::tz::TimeZone::system()
        .iana_name()
        .unwrap_or("UTC")
        .to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthState {
    needs_setup: bool,
    user: Option<PublicUser>,
    server_name: String,
    public_outputs: bool,
}

async fn auth_state(State(s): State<Shared>, MaybeUser(user): MaybeUser) -> Json<AuthState> {
    Json(AuthState {
        needs_setup: s.auth.needs_setup(),
        user: user.as_ref().map(PublicUser::from),
        server_name: s.config.name.clone(),
        public_outputs: s.config.public_outputs,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    display_name: String,
}

#[derive(Serialize)]
struct LoginReply {
    user: PublicUser,
    /// Also usable as `Authorization: Bearer <token>` by automation.
    token: String,
}

fn login_response(token: String, user: &User) -> Response {
    let cookie = session_cookie(&token, 14 * 24 * 3600);
    (
        [(header::SET_COOKIE, cookie)],
        Json(LoginReply {
            user: user.into(),
            token,
        }),
    )
        .into_response()
}

/// First admin account: only while no user exists, and only from the
/// server itself (or `cg-server user add` on the command line).
async fn auth_setup(
    State(s): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(c): Json<Credentials>,
) -> ApiResult<Response> {
    if !s.auth.needs_setup() {
        return Err((StatusCode::CONFLICT, "already set up".into()));
    }
    if !peer.ip().is_loopback() {
        return Err((StatusCode::FORBIDDEN, "the first admin must be created on the server itself (http://localhost) or with `cg-server user add`".into()));
    }
    let input = UserInput {
        username: c.username,
        display_name: c.display_name,
        role: Role::Admin,
        projects: None,
        channels: None,
        disabled: false,
        password: c.password.clone(),
    };
    let user = s.auth.create(input).map_err(bad)?;
    let (token, user) = s
        .auth
        .login(&user.username, &c.password)
        .ok_or_else(|| internal("login failed"))?;
    Ok(login_response(token, &user))
}

async fn auth_login(State(s): State<Shared>, Json(c): Json<Credentials>) -> ApiResult<Response> {
    let auth = s.auth.clone();
    // Argon2 is deliberately slow: keep it off the async workers.
    let res = tokio::task::spawn_blocking(move || auth.login(&c.username, &c.password))
        .await
        .map_err(internal)?;
    match res {
        Some((token, user)) => Ok(login_response(token, &user)),
        None => Err((
            StatusCode::UNAUTHORIZED,
            "wrong user name or password".into(),
        )),
    }
}

async fn auth_logout(State(s): State<Shared>, headers: HeaderMap) -> Response {
    let (mut parts, _) = axum::http::Request::new(()).into_parts();
    parts.headers = headers;
    if let Some(t) = auth::token_from(&parts) {
        s.auth.logout(&t);
    }
    (
        [(header::SET_COOKIE, session_cookie("", 0))],
        StatusCode::NO_CONTENT,
    )
        .into_response()
}

// ----------------------------------------------------------------- users ----

async fn list_users(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> ApiResult<Json<Vec<PublicUser>>> {
    require(me.is_admin())?;
    Ok(Json(s.auth.users().iter().map(PublicUser::from).collect()))
}

async fn create_user(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(input): Json<UserInput>,
) -> ApiResult<Json<PublicUser>> {
    require(me.is_admin())?;
    let auth = s.auth.clone();
    let u = tokio::task::spawn_blocking(move || auth.create(input))
        .await
        .map_err(internal)?
        .map_err(bad)?;
    Ok(Json((&u).into()))
}

async fn update_user(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(input): Json<UserInput>,
) -> ApiResult<Json<PublicUser>> {
    require(me.is_admin())?;
    let auth = s.auth.clone();
    let u = tokio::task::spawn_blocking(move || auth.update(&id, input))
        .await
        .map_err(internal)?
        .map_err(bad)?;
    Ok(Json((&u).into()))
}

async fn delete_user(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    require(me.is_admin())?;
    if id == me.id {
        return Err(bad("you cannot delete your own account"));
    }
    s.auth.delete(&id).map_err(bad)?;
    Ok(StatusCode::NO_CONTENT)
}

// -------------------------------------------------------------- projects ----

async fn list_projects(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> Json<Vec<ProjectSummary>> {
    Json(
        s.summaries()
            .await
            .into_iter()
            .filter(|p| me.sees_project(&p.id))
            .collect(),
    )
}

async fn visible_project(s: &Shared, me: &User, id: &str) -> ApiResult<std::sync::Arc<Project>> {
    if !me.sees_project(id) {
        return Err(not_found("project"));
    }
    s.project(id).await.ok_or_else(|| not_found("project"))
}

async fn get_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Project>> {
    Ok(Json((*visible_project(&s, &me, &id).await?).clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewProject {
    name: String,
    #[serde(default)]
    description: String,
    width: Option<u32>,
    height: Option<u32>,
    frame_rate: Option<FrameRate>,
    /// Duplicate this project instead of starting empty.
    #[serde(default)]
    from: Option<String>,
}

fn check_format(width: u32, height: u32, rate: FrameRate) -> ApiResult<()> {
    if !(16..=7680).contains(&width)
        || !(16..=4320).contains(&height)
        || rate.num == 0
        || rate.den == 0
    {
        return Err(bad("invalid video format"));
    }
    Ok(())
}

async fn create_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(n): Json<NewProject>,
) -> ApiResult<Json<ProjectSummary>> {
    require(me.can_create_projects())?;
    if n.name.trim().is_empty() {
        return Err(bad("a project needs a name"));
    }
    let mut p = match &n.from {
        Some(src) => {
            let mut p = (*visible_project(&s, &me, src).await?).clone();
            p.rundown.iter_mut().for_each(|r| r.id = cg_core::new_id());
            p
        }
        None => Project {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::new(50, 1),
            templates: Vec::new(),
            rundown: Vec::new(),
            zones: cg_core::Zone::defaults(),
        },
    };
    p.id = cg_core::new_id();
    p.name = n.name.trim().to_string();
    p.description = n.description;
    if let Some(w) = n.width {
        p.width = w;
    }
    if let Some(h) = n.height {
        p.height = h;
    }
    if let Some(r) = n.frame_rate {
        p.frame_rate = r;
    }
    check_format(p.width, p.height, p.frame_rate)?;
    let p = s.save_project(p).await.map_err(internal)?;
    Ok(Json(ProjectSummary::from(p.as_ref())))
}

async fn import_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(mut p): Json<Project>,
) -> ApiResult<Json<ProjectSummary>> {
    require(me.can_create_projects())?;
    check_format(p.width, p.height, p.frame_rate)?;
    if !valid_id(&p.id) || s.project(&p.id).await.is_some() {
        p.id = cg_core::new_id();
    }
    let p = s.save_project(p).await.map_err(internal)?;
    Ok(Json(ProjectSummary::from(p.as_ref())))
}

async fn export_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let p = visible_project(&s, &me, &id).await?;
    let name: String = p
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let disposition = format!("attachment; filename=\"{name}.pulsecg.json\"");
    let body = serde_json::to_vec_pretty(p.as_ref()).map_err(internal)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    name: String,
    #[serde(default)]
    description: String,
    width: u32,
    height: u32,
    frame_rate: FrameRate,
}

async fn put_project_meta(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(m): Json<ProjectMeta>,
) -> ApiResult<StatusCode> {
    require(me.can_design(&id))?;
    check_format(m.width, m.height, m.frame_rate)?;
    let mut p = (*visible_project(&s, &me, &id).await?).clone();
    p.name = m.name.trim().to_string();
    p.description = m.description;
    p.width = m.width;
    p.height = m.height;
    p.frame_rate = m.frame_rate;
    s.save_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    require(me.can_design(&id))?;
    if !s.delete_project(&id).await.map_err(internal)? {
        return Err(not_found("project"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn put_template(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((id, tid)): Path<(String, String)>,
    Json(t): Json<Template>,
) -> ApiResult<StatusCode> {
    require(me.can_design(&id))?;
    if t.id != tid {
        return Err(bad("template id mismatch"));
    }
    let mut p = (*visible_project(&s, &me, &id).await?).clone();
    match p.templates.iter_mut().find(|x| x.id == tid) {
        Some(existing) => *existing = t,
        None => p.templates.push(t),
    }
    s.save_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_template(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((id, tid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    require(me.can_design(&id))?;
    let mut p = (*visible_project(&s, &me, &id).await?).clone();
    let before = p.templates.len();
    p.templates.retain(|t| t.id != tid);
    if p.templates.len() == before {
        return Err(not_found("template"));
    }
    p.rundown.retain(|r| r.template_id != tid);
    s.save_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn put_rundown(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(r): Json<Vec<RundownItem>>,
) -> ApiResult<StatusCode> {
    require(me.can_edit_rundown(&id))?;
    let mut p = (*visible_project(&s, &me, &id).await?).clone();
    p.rundown = r;
    s.save_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replaces the zones of a project. Zones still used by templates or the
/// rundown cannot be removed; graphics on air follow their zone's new layer.
async fn put_zones(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(zones): Json<Vec<cg_core::Zone>>,
) -> ApiResult<StatusCode> {
    require(me.can_design(&id))?;
    Project::validate_zones(&zones).map_err(bad)?;
    let mut p = (*visible_project(&s, &me, &id).await?).clone();
    let kept = |z: &str| zones.iter().any(|x| x.id == z);
    if let Some(t) = p.templates.iter().find(|t| !kept(&t.zone)) {
        return Err(bad(format!(
            "template “{}” still plays in a removed zone; move it first",
            t.name
        )));
    }
    if let Some(r) = p
        .rundown
        .iter()
        .find(|r| !r.zone.is_empty() && !kept(&r.zone))
    {
        return Err(bad(format!(
            "rundown item “{}” still plays in a removed zone; move it first",
            r.name
        )));
    }
    let moves: Vec<(u32, u32)> = p
        .zones
        .iter()
        .filter_map(|old| {
            zones
                .iter()
                .find(|n| n.id == old.id && n.layer != old.layer)
                .map(|n| (old.layer, n.layer))
        })
        .collect();
    p.zones = zones;
    s.save_project(p).await.map_err(internal)?;
    if !moves.is_empty() {
        s.move_layers(&id, &moves).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

fn png(bytes: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response()
}

#[derive(Deserialize)]
struct ThumbQuery {
    frame: Option<f64>,
}

async fn template_thumbnail(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((id, tid)): Path<(String, String)>,
    Query(q): Query<ThumbQuery>,
) -> ApiResult<Response> {
    let p = visible_project(&s, &me, &id).await?;
    let template = p
        .template(&tid)
        .cloned()
        .ok_or_else(|| not_found("template"))?;
    // Default to the first hold point: that's what the graphic looks like on air.
    let frame = q.frame.unwrap_or_else(|| {
        template
            .next_pause_after(0.0)
            .or(template.out_frame())
            .unwrap_or(template.duration)
    });
    let st = s.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let mut r = st.renderer.lock().unwrap_or_else(|e| e.into_inner());
        r.render_template(&p, &template, frame, &template.default_data())
            .to_png()
    })
    .await
    .map_err(internal)?;
    Ok(png(bytes))
}

// -------------------------------------------------------------- channels ----

async fn list_channels(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> Json<Vec<ChannelInfo>> {
    Json(
        s.channel_infos()
            .await
            .into_iter()
            .filter(|c| me.sees_channel(&c.id))
            .collect(),
    )
}

fn visible_channel(me: &User, id: &str) -> ApiResult<()> {
    if me.sees_channel(id) {
        Ok(())
    } else {
        Err(not_found("channel"))
    }
}

async fn channel_state(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    visible_channel(&me, &id)?;
    let ch = s.channel(&id).ok_or_else(|| not_found("channel"))?;
    Ok(Json(ch.state.read().await.clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadProject {
    project_id: Option<String>,
}

async fn load_project(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(l): Json<LoadProject>,
) -> ApiResult<StatusCode> {
    visible_channel(&me, &id)?;
    require(me.can_operate(&id))?;
    if let Some(pid) = &l.project_id {
        require(me.sees_project(pid))?;
    }
    s.load_project(&id, l.project_id).await.map_err(bad)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn channel_command(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(cmd): Json<Command>,
) -> ApiResult<impl IntoResponse> {
    visible_channel(&me, &id)?;
    require(me.can_operate(&id))?;
    s.command(&id, cmd).await.map(Json).map_err(bad)
}

async fn channel_preview(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    visible_channel(&me, &id)?;
    let ch = s.channel(&id).ok_or_else(|| not_found("channel"))?.clone();
    let project = match ch.project_id.read().await.clone() {
        Some(pid) => s.project(&pid).await,
        None => None,
    };
    let state = ch.state.read().await.clone();
    let out = cg_render::OutputFormat {
        width: ch.config.width,
        height: ch.config.height,
    };
    let tz = s.config.timezone.clone();
    let st = s.clone();
    let bytes = tokio::task::spawn_blocking(move || match project {
        Some(p) => st
            .renderer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .render_channel(&p, &state, out, &tz)
            .to_png(),
        None => cg_render::Frame::blank(out.width, out.height).to_png(),
    })
    .await
    .map_err(internal)?;
    Ok(png(bytes))
}

async fn get_sdp(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path((id, name, essence)): Path<(String, String, String)>,
) -> ApiResult<Response> {
    visible_channel(&me, &id)?;
    let ch = s.channel(&id).ok_or_else(|| not_found("channel"))?;
    let c = &ch.config;
    let cfg = c
        .outputs
        .st2110
        .iter()
        .find(|o| o.name == name)
        .ok_or_else(|| not_found("output"))?;
    let key = match essence.as_str() {
        "fill.sdp" => false,
        "key.sdp" => true,
        _ => return Err((StatusCode::NOT_FOUND, "use fill.sdp or key.sdp".into())),
    };
    let sdp = cfg
        .sdp(c.width, c.height, (c.frame_rate.num, c.frame_rate.den), key)
        .ok_or_else(|| not_found("key stream"))?;
    Ok(([(header::CONTENT_TYPE, "application/sdp")], sdp).into_response())
}

// ---------------------------------------------------------------- assets ----

fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 128
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

async fn list_assets(
    State(s): State<Shared>,
    CurrentUser(_): CurrentUser,
) -> ApiResult<Json<Vec<String>>> {
    let mut out = Vec::new();
    let mut dir = match tokio::fs::read_dir(s.assets_dir()).await {
        Ok(d) => d,
        Err(_) => return Ok(Json(out)),
    };
    while let Some(e) = dir.next_entry().await.map_err(internal)? {
        if e.file_type().await.map(|t| t.is_file()).unwrap_or(false) {
            out.push(format!("/assets/{}", e.file_name().to_string_lossy()));
        }
    }
    out.sort();
    Ok(Json(out))
}

async fn put_asset(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(name): Path<String>,
    body: Bytes,
) -> ApiResult<Json<BTreeMap<&'static str, String>>> {
    // Operators upload pictures for image fields too.
    require(me.role != Role::Viewer)?;
    if !valid_asset_name(&name) {
        return Err(bad("invalid asset name"));
    }
    tokio::fs::create_dir_all(s.assets_dir())
        .await
        .map_err(internal)?;
    tokio::fs::write(s.assets_dir().join(&name), &body)
        .await
        .map_err(internal)?;
    s.renderer
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .invalidate_assets();
    Ok(Json(BTreeMap::from([("src", format!("/assets/{name}"))])))
}

// ---------------------------------------------------------------- system ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetInterface {
    name: String,
    ip: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    hostname: String,
    cpus: usize,
    data_dir: String,
    bind: String,
    uptime_secs: u64,
    timezone: String,
    /// Admins only.
    config: Option<ServerConfig>,
    interfaces: Vec<NetInterface>,
}

async fn get_system(State(s): State<Shared>, CurrentUser(me): CurrentUser) -> Json<SystemInfo> {
    let mut interfaces: Vec<NetInterface> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.ip().is_ipv4())
        .map(|i| NetInterface {
            ip: i.ip().to_string(),
            name: i.name,
        })
        .collect();
    interfaces.sort_by(|a, b| a.name.cmp(&b.name));
    Json(SystemInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        hostname: gethostname::gethostname().to_string_lossy().into_owned(),
        cpus: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        data_dir: s.data_dir.display().to_string(),
        bind: s.bind.to_string(),
        uptime_secs: s.started_at.elapsed().map(|d| d.as_secs()).unwrap_or(0),
        timezone: server_timezone(&s),
        // Re-read so the loaded projects are current.
        config: me.is_admin().then(|| ServerConfig::load(&s.data_dir)),
        interfaces,
    })
}

/// Saves the settings and restarts the engine (and listener) with them.
async fn put_system_config(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(cfg): Json<ServerConfig>,
) -> ApiResult<StatusCode> {
    require(me.is_admin())?;
    cfg.validate().map_err(bad)?;
    if let Some(bind) = cfg.bind.filter(|b| *b != s.bind) {
        // Fail early rather than restarting into an address we cannot use.
        std::net::TcpListener::bind(bind)
            .map_err(|e| bad(format!("cannot listen on {bind}: {e}")))?;
    }
    let dir = s.data_dir.clone();
    tokio::task::spawn_blocking(move || cfg.save(&dir))
        .await
        .map_err(internal)?
        .map_err(internal)?;
    tracing::info!("settings saved, restarting the engine");
    s.restart.notify_one();
    Ok(StatusCode::ACCEPTED)
}

/// Unauthenticated status for the desktop tray app and monitoring.
async fn health(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "name": s.config.name,
        "version": env!("CARGO_PKG_VERSION"),
        "bind": s.bind,
        "channels": s.channels.len(),
        "needsSetup": s.auth.needs_setup(),
    }))
}

#[derive(Deserialize)]
struct QrQuery {
    data: String,
}

/// QR modules for the HTML5 renderer (public: output pages need it).
async fn qr(Query(q): Query<QrQuery>) -> ApiResult<Json<serde_json::Value>> {
    if q.data.len() > 2048 {
        return Err(bad("too long for a QR code"));
    }
    let (size, modules) = cg_render::qr_modules(&q.data).ok_or_else(|| bad("cannot encode"))?;
    let modules: String = modules.iter().map(|d| if *d { '1' } else { '0' }).collect();
    Ok(Json(
        serde_json::json!({ "size": size, "modules": modules }),
    ))
}

/// `/output` without a channel: the first channel (tray app, old links).
async fn output_redirect(State(s): State<Shared>) -> Response {
    match s.channels.keys().next() {
        Some(id) => axum::response::Redirect::temporary(&format!("/output/{id}")).into_response(),
        None => not_found("channel").into_response(),
    }
}

/// Admins, or the tray app on the server itself.
async fn post_restart(
    State(s): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    MaybeUser(me): MaybeUser,
) -> ApiResult<StatusCode> {
    require(peer.ip().is_loopback() || me.is_some_and(|u| u.is_admin()))?;
    s.restart.notify_one();
    Ok(StatusCode::ACCEPTED)
}

// --------------------------------------------------------------- update ----

async fn update_info(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> ApiResult<Json<crate::update::Info>> {
    require(me.is_admin())?;
    let dir = s.data_dir.clone();
    Ok(Json(
        tokio::task::spawn_blocking(move || crate::update::info(&dir))
            .await
            .map_err(internal)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettingsInput {
    repo: String,
    /// None = keep the stored token, "" = remove it.
    #[serde(default)]
    token: Option<String>,
    #[serde(default = "yes")]
    auto_check: bool,
}

fn yes() -> bool {
    true
}

async fn update_settings(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(i): Json<UpdateSettingsInput>,
) -> ApiResult<StatusCode> {
    require(me.is_admin())?;
    let repo = i
        .repo
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_end_matches('/')
        .to_string();
    if repo.split('/').count() != 2 || repo.split('/').any(|p| p.is_empty()) {
        return Err(bad("the repository is written owner/name"));
    }
    let mut cfg = crate::update::Settings::load(&s.data_dir);
    cfg.repo = repo;
    cfg.auto_check = i.auto_check;
    if let Some(t) = i.token {
        cfg.token = t.trim().to_string();
    }
    cfg.save(&s.data_dir).map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_check(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> ApiResult<Json<crate::update::Release>> {
    require(me.is_admin())?;
    let dir = s.data_dir.clone();
    tokio::task::spawn_blocking(move || crate::update::check(&dir))
        .await
        .map_err(internal)?
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("{e:#}")))
}

/// Downloads and installs the latest release in the background; follow
/// progress with GET /api/system/update.
async fn update_install(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> ApiResult<StatusCode> {
    require(me.is_admin())?;
    tracing::warn!(user = me.username, "installing the latest release");
    let dir = s.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let _ = crate::update::install_latest(&dir);
    });
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadQuery {
    /// Install even if it is not newer (downgrade / reinstall).
    #[serde(default)]
    allow_older: bool,
}

/// Installs a release archive uploaded by an admin (offline servers).
async fn update_upload(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    require(me.is_admin())?;
    tracing::warn!(
        user = me.username,
        bytes = body.len(),
        "installing an uploaded package"
    );
    let dir = s.data_dir.clone();
    let version = tokio::task::spawn_blocking(move || {
        let r = crate::update::extract_binary(&body)
            .and_then(|b| crate::update::install(&dir, &b, q.allow_older));
        if let Err(e) = &r {
            crate::update::fail(e);
        }
        r
    })
    .await
    .map_err(internal)?
    .map_err(|e| bad(format!("{e:#}")))?;
    crate::update::restart_soon();
    Ok(Json(serde_json::json!({ "version": version })))
}

async fn update_rollback(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> ApiResult<Json<serde_json::Value>> {
    require(me.is_admin())?;
    let dir = s.data_dir.clone();
    let version = tokio::task::spawn_blocking(move || crate::update::rollback(&dir, "rolled back"))
        .await
        .map_err(internal)?
        .map_err(|e| bad(format!("{e:#}")))?;
    crate::update::restart_soon();
    Ok(Json(serde_json::json!({ "version": version })))
}

// ------------------------------------------------------------- websocket ----

#[derive(Deserialize)]
struct WsQuery {
    /// Output page mode: follow this channel only (and its project).
    channel: Option<String>,
}

/// What a socket may see.
struct Viewer {
    user: Option<User>,
    /// Output pages follow one channel.
    channel: Option<String>,
}

impl Viewer {
    fn sees_channel(&self, id: &str) -> bool {
        match (&self.user, &self.channel) {
            (_, Some(c)) => c == id,
            (Some(u), None) => u.sees_channel(id),
            (None, None) => false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    r#type: &'static str,
    user: Option<PublicUser>,
    server_name: String,
    server_time: i64,
    timezone: String,
    channels: Vec<ChannelInfo>,
    projects: Vec<ProjectSummary>,
}

async fn ws_upgrade(
    State(s): State<Shared>,
    MaybeUser(user): MaybeUser,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if user.is_none() && !(s.config.public_outputs && q.channel.is_some()) {
        return (StatusCode::UNAUTHORIZED, "login required").into_response();
    }
    if let Some(c) = &q.channel {
        if s.channel(c).is_none() || user.as_ref().is_some_and(|u| !u.sees_channel(c)) {
            return not_found("channel").into_response();
        }
    }
    let viewer = Viewer {
        user,
        channel: q.channel,
    };
    ws.on_upgrade(move |socket| ws_session(s, socket, viewer))
}

async fn ws_session(s: Shared, socket: WebSocket, viewer: Viewer) {
    let (mut tx, mut rx) = socket.split();
    let mut events = s.events.subscribe();
    let closing = crate::state::until_true(s.closing.subscribe());
    tokio::pin!(closing);

    let channels: Vec<ChannelInfo> = s
        .channel_infos()
        .await
        .into_iter()
        .filter(|c| viewer.sees_channel(&c.id))
        .collect();
    let projects = match &viewer.user {
        Some(u) if viewer.channel.is_none() => s
            .summaries()
            .await
            .into_iter()
            .filter(|p| u.sees_project(&p.id))
            .collect(),
        _ => Vec::new(),
    };
    // Output pages get the full project of their channel up front.
    let mut followed: Option<String> = channels
        .first()
        .filter(|_| viewer.channel.is_some())
        .and_then(|c| c.project_id.clone());
    let hello = Hello {
        r#type: "hello",
        user: viewer.user.as_ref().map(PublicUser::from),
        server_name: s.config.name.clone(),
        server_time: now_ms(),
        timezone: server_timezone(&s),
        channels: channels.clone(),
        projects,
    };
    let Ok(json) = serde_json::to_string(&hello) else {
        return;
    };
    if tx.send(Message::Text(json.into())).await.is_err() {
        return;
    }
    if let Some(p) = match &followed {
        Some(id) => s.project(id).await,
        None => None,
    } {
        if send(&mut tx, &Event::Project { project: p }).await.is_err() {
            return;
        }
    }
    for c in &channels {
        if let Some(ch) = s.channel(&c.id) {
            let ev = Event::Channel {
                channel_id: c.id.clone(),
                state: ch.state.read().await.clone(),
                server_time: now_ms(),
            };
            if send(&mut tx, &ev).await.is_err() {
                return;
            }
        }
    }

    loop {
        tokio::select! {
            // Engine restart / shutdown: close so the client reconnects.
            _ = &mut closing => break,
            ev = events.recv() => {
                let ev = match ev {
                    Ok(ev) => ev,
                    // Slow client: states are absolute, the next one catches up.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                let mut extra = None;
                let visible = match &ev {
                    Event::Project { project } => match (&viewer.user, &viewer.channel) {
                        (_, Some(_)) => followed.as_deref() == Some(project.id.as_str()),
                        (Some(u), None) => u.sees_project(&project.id),
                        (None, None) => false,
                    },
                    Event::ProjectDeleted { id } => viewer.user.as_ref().is_some_and(|u| u.sees_project(id)),
                    Event::Channel { channel_id, .. } => viewer.sees_channel(channel_id),
                    Event::Channels { channels } => {
                        // An output page switches project with its channel.
                        if let Some(c) = viewer.channel.as_ref().and_then(|id| channels.iter().find(|c| &c.id == id)) {
                            if c.project_id != followed {
                                followed = c.project_id.clone();
                                if let Some(id) = &followed {
                                    extra = s.project(id).await.map(|project| Event::Project { project });
                                }
                            }
                        }
                        true
                    }
                    Event::Error { .. } => false,
                };
                if !visible {
                    continue;
                }
                let ev = match ev {
                    Event::Channels { channels } => Event::Channels { channels: channels.into_iter().filter(|c| viewer.sees_channel(&c.id)).collect() },
                    other => other,
                };
                if let Some(x) = extra {
                    if send(&mut tx, &x).await.is_err() { break }
                }
                if send(&mut tx, &ev).await.is_err() { break }
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let reply = match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(ClientMessage::Command { channel_id, command }) => match &viewer.user {
                            Some(u) if u.can_operate(&channel_id) => s.command(&channel_id, command).await.err(),
                            _ => Some("you do not have the rights to operate this channel".into()),
                        },
                        Err(e) => Some(e.to_string()),
                    };
                    if let Some(message) = reply {
                        if send(&mut tx, &Event::Error { message }).await.is_err() { break }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}

async fn send<S>(tx: &mut S, ev: &Event) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let json = serde_json::to_string(ev).map_err(|_| ())?;
    tx.send(Message::Text(json.into())).await.map_err(|_| ())
}
