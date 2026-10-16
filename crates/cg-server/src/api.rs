//! REST + WebSocket API used by the web app and by automation systems
//! (Companion / Stream Deck, newsroom MOS gateways, sports data feeds...).

use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use cg_core::{Command, Project, RundownItem, Template};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::state::{ClientMessage, Event, Shared};

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/project", get(get_project).put(put_project))
        .route(
            "/api/templates/{id}",
            put(put_template).delete(delete_template),
        )
        .route("/api/templates/{id}/thumbnail.png", get(template_thumbnail))
        .route("/api/rundown", put(put_rundown))
        .route("/api/channel", get(get_channel))
        .route("/api/channel/command", post(post_command))
        .route("/api/channel/preview.png", get(channel_preview))
        .route("/api/outputs", get(get_outputs))
        .route("/api/outputs/{name}/{essence}", get(get_sdp))
        .route("/api/assets", get(list_assets))
        .route("/api/assets/{name}", put(put_asset))
        .route("/ws", get(ws_upgrade))
}

type ApiResult<T> = Result<T, (StatusCode, String)>;

fn bad(e: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, e.to_string())
}

fn internal(e: impl ToString) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

async fn get_project(State(s): State<Shared>) -> Json<Project> {
    Json((**s.project.read().await).clone())
}

async fn put_project(State(s): State<Shared>, Json(p): Json<Project>) -> ApiResult<StatusCode> {
    if p.width == 0 || p.height == 0 || p.width > 7680 || p.height > 4320 {
        return Err(bad("invalid resolution"));
    }
    s.set_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn put_template(
    State(s): State<Shared>,
    Path(id): Path<String>,
    Json(t): Json<Template>,
) -> ApiResult<StatusCode> {
    if t.id != id {
        return Err(bad("template id mismatch"));
    }
    let mut p = (**s.project.read().await).clone();
    match p.templates.iter_mut().find(|x| x.id == id) {
        Some(existing) => *existing = t,
        None => p.templates.push(t),
    }
    s.set_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_template(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let mut p = (**s.project.read().await).clone();
    let before = p.templates.len();
    p.templates.retain(|t| t.id != id);
    if p.templates.len() == before {
        return Err((StatusCode::NOT_FOUND, "no such template".into()));
    }
    p.rundown.retain(|r| r.template_id != id);
    s.set_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn put_rundown(
    State(s): State<Shared>,
    Json(r): Json<Vec<RundownItem>>,
) -> ApiResult<StatusCode> {
    let mut p = (**s.project.read().await).clone();
    p.rundown = r;
    s.set_project(p).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_channel(State(s): State<Shared>) -> impl IntoResponse {
    Json(s.channel.read().await.clone())
}

async fn post_command(
    State(s): State<Shared>,
    Json(cmd): Json<Command>,
) -> ApiResult<impl IntoResponse> {
    s.command(cmd).await.map(Json).map_err(bad)
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

async fn channel_preview(State(s): State<Shared>) -> ApiResult<Response> {
    let project = s.project.read().await.clone();
    let channel = s.channel.read().await.clone();
    let st = s.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let mut r = st.renderer.lock().unwrap_or_else(|e| e.into_inner());
        r.render_channel(&project, &channel).to_png()
    })
    .await
    .map_err(internal)?;
    Ok(png(bytes))
}

#[derive(Deserialize)]
struct ThumbQuery {
    frame: Option<f64>,
}

async fn template_thumbnail(
    State(s): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<ThumbQuery>,
) -> ApiResult<Response> {
    let project = s.project.read().await.clone();
    let template = project
        .template(&id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, "no such template".to_string()))?;
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
        r.render_template(&project, &template, frame, &template.default_data())
            .to_png()
    })
    .await
    .map_err(internal)?;
    Ok(png(bytes))
}

async fn get_outputs(State(s): State<Shared>) -> impl IntoResponse {
    Json(s.outputs.clone())
}

async fn get_sdp(
    State(s): State<Shared>,
    Path((name, essence)): Path<(String, String)>,
) -> ApiResult<Response> {
    let p = s.project.read().await.clone();
    let cfg = s
        .outputs
        .st2110
        .iter()
        .find(|o| o.name == name)
        .ok_or((StatusCode::NOT_FOUND, "no such output".to_string()))?;
    let key = match essence.as_str() {
        "fill.sdp" => false,
        "key.sdp" => true,
        _ => return Err((StatusCode::NOT_FOUND, "use fill.sdp or key.sdp".into())),
    };
    let sdp = cfg
        .sdp(p.width, p.height, (p.frame_rate.num, p.frame_rate.den), key)
        .ok_or((
            StatusCode::NOT_FOUND,
            "no key stream configured".to_string(),
        ))?;
    Ok(([(header::CONTENT_TYPE, "application/sdp")], sdp).into_response())
}

fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 128
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

async fn list_assets(State(s): State<Shared>) -> ApiResult<Json<Vec<String>>> {
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
    Path(name): Path<String>,
    body: Bytes,
) -> ApiResult<Json<BTreeMap<&'static str, String>>> {
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

async fn ws_upgrade(State(s): State<Shared>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| ws_session(s, socket))
}

async fn ws_session(s: Shared, socket: WebSocket) {
    let (mut tx, mut rx) = socket.split();
    let mut events = s.events.subscribe();
    let hello = [
        Event::Project {
            project: s.project.read().await.clone(),
        },
        Event::Channel {
            state: s.channel.read().await.clone(),
        },
    ];
    for ev in hello {
        if send(&mut tx, &ev).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(ev) => if send(&mut tx, &ev).await.is_err() { break },
                // Slow client: skip missed ticks, state messages are absolute.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let ev = Event::Channel { state: s.channel.read().await.clone() };
                    if send(&mut tx, &ev).await.is_err() { break }
                }
                Err(_) => break,
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let reply = match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(ClientMessage::Command { command }) => s.command(command).await.err(),
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
