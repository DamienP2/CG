use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use cg_core::{ChannelState, Command, Project};
use cg_output::st2110::St2110Config;
use cg_render::Renderer;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputsConfig {
    #[serde(default)]
    pub st2110: Vec<St2110Config>,
    #[serde(default)]
    pub sdi: Vec<cg_output::sdi::SdiConfig>,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub project: RwLock<Arc<Project>>,
    pub channel: RwLock<ChannelState>,
    pub events: broadcast::Sender<Event>,
    pub renderer: Mutex<Renderer>,
    pub outputs: OutputsConfig,
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

pub fn load_outputs(data_dir: &std::path::Path) -> OutputsConfig {
    let path = data_dir.join("outputs.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::error!(?path, "invalid outputs file: {e}");
            OutputsConfig::default()
        }),
        Err(_) => OutputsConfig::default(),
    }
}
