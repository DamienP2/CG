use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use cg_core::{ChannelState, Command, Project};
use cg_render::Renderer;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch, Notify, RwLock};

use crate::config::ServerConfig;

/// Messages pushed to every WebSocket client.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Project { project: Arc<Project> },
    Channel { state: ChannelState },
    Error { message: String },
}

/// Messages accepted from WebSocket clients.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Command { command: Command },
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub project: RwLock<Arc<Project>>,
    pub channel: RwLock<ChannelState>,
    pub events: broadcast::Sender<Event>,
    pub renderer: Mutex<Renderer>,
    /// Settings this engine cycle was started with.
    pub config: ServerConfig,
    /// Address actually bound by this cycle.
    pub bind: SocketAddr,
    pub started_at: SystemTime,
    /// Ask the server loop to rebuild the engine with fresh settings.
    pub restart: Notify,
    /// Flips to true when this cycle ends, so long-lived WebSockets close.
    pub closing: watch::Sender<bool>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn assets_dir(&self) -> PathBuf {
        self.data_dir.join("assets")
    }

    fn project_path(&self) -> PathBuf {
        self.data_dir.join("project.json")
    }

    pub async fn set_project(&self, project: Project) -> anyhow::Result<()> {
        let json = serde_json::to_vec_pretty(&project)?;
        let tmp = self.project_path().with_extension("json.tmp");
        tokio::fs::write(&tmp, json).await?;
        tokio::fs::rename(&tmp, self.project_path()).await?;
        let p = Arc::new(project);
        *self.project.write().await = p.clone();
        let _ = self.events.send(Event::Project { project: p });
        Ok(())
    }

    pub async fn command(&self, cmd: Command) -> Result<ChannelState, String> {
        let project = self.project.read().await.clone();
        let mut ch = self.channel.write().await;
        ch.apply(&project, cmd).map_err(|e| e.to_string())?;
        let snapshot = ch.clone();
        let _ = self.events.send(Event::Channel {
            state: snapshot.clone(),
        });
        Ok(snapshot)
    }
}

pub fn load_project(data_dir: &std::path::Path) -> Project {
    let path = data_dir.join("project.json");
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(p) => return p,
            Err(e) => tracing::error!(?path, "invalid project file ({e}), using demo project"),
        },
        Err(_) => tracing::info!("no project yet, starting with the demo project"),
    }
    let p = cg_core::sample::demo_project();
    let _ = std::fs::write(&path, serde_json::to_vec_pretty(&p).unwrap_or_default());
    p
}

/// Resolves once the watched flag becomes true (or its sender is gone).
pub async fn until_true(mut rx: watch::Receiver<bool>) {
    while !*rx.borrow_and_update() {
        if rx.changed().await.is_err() {
            return;
        }
    }
}
