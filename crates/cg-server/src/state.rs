use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use cg_core::{ChannelState, Command, Project};
use cg_render::Renderer;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch, Notify, RwLock};

use crate::auth::Auth;
use crate::config::{ChannelConfig, ServerConfig};
use crate::library::{Library, ProjectSummary};

/// Messages pushed to WebSocket clients (filtered per user by the session).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// A project was created or saved.
    Project {
        project: Arc<Project>,
    },
    ProjectDeleted {
        id: String,
    },
    /// Channel list or loaded projects changed.
    Channels {
        channels: Vec<ChannelInfo>,
    },
    /// Playout state of one channel.
    #[serde(rename_all = "camelCase")]
    Channel {
        channel_id: String,
        state: ChannelState,
        server_time: i64,
    },
    Error {
        message: String,
    },
}

/// Messages accepted from WebSocket clients.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Command {
        channel_id: String,
        command: Command,
    },
}

/// A channel as shown to clients.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: cg_core::FrameRate,
    pub project_id: Option<String>,
    pub outputs: Vec<String>,
    /// Extra pictures of the channel (9:16…), each with its HTML5 page
    /// /output/<channel>/<rendition>.
    pub renditions: Vec<RenditionInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenditionInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

pub struct ChannelRt {
    pub config: ChannelConfig,
    pub project_id: RwLock<Option<String>>,
    pub state: RwLock<ChannelState>,
}

impl ChannelRt {
    pub async fn info(&self) -> ChannelInfo {
        let c = &self.config;
        let outputs = c
            .pictures()
            .into_iter()
            .flat_map(|(_, _, _, o)| {
                o.st2110
                    .iter()
                    .map(|o| format!("ST 2110 · {}", o.name))
                    .chain(o.sdi.iter().map(|o| format!("SDI · {}", o.name)))
            })
            .collect();
        ChannelInfo {
            id: c.id.clone(),
            name: c.name.clone(),
            width: c.width,
            height: c.height,
            frame_rate: c.frame_rate,
            project_id: self.project_id.read().await.clone(),
            outputs,
            renditions: c
                .renditions
                .iter()
                .map(|r| RenditionInfo {
                    id: r.id.clone(),
                    name: r.name.clone(),
                    width: r.width,
                    height: r.height,
                })
                .collect(),
        }
    }
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub library: RwLock<Library>,
    pub channels: BTreeMap<String, Arc<ChannelRt>>,
    pub events: broadcast::Sender<Event>,
    pub renderer: Mutex<Renderer>,
    /// Users and sessions outlive engine restarts.
    pub auth: Arc<Auth>,
    /// Running orders received from the newsroom system (MOS).
    pub mos: Arc<crate::mos::Store>,
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

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl AppState {
    pub fn assets_dir(&self) -> PathBuf {
        self.data_dir.join("assets")
    }

    pub fn channel(&self, id: &str) -> Option<&Arc<ChannelRt>> {
        self.channels.get(id)
    }

    pub async fn project(&self, id: &str) -> Option<Arc<Project>> {
        self.library.read().await.get(id)
    }

    pub async fn summaries(&self) -> Vec<ProjectSummary> {
        self.library
            .read()
            .await
            .list()
            .map(|p| ProjectSummary::from(p.as_ref()))
            .collect()
    }

    pub async fn channel_infos(&self) -> Vec<ChannelInfo> {
        let mut out = Vec::new();
        for c in self.channels.values() {
            out.push(c.info().await);
        }
        out
    }

    pub async fn save_project(&self, mut project: Project) -> anyhow::Result<Arc<Project>> {
        project.ensure_zones();
        let p = self.library.write().await.save(project)?;
        let _ = self.events.send(Event::Project { project: p.clone() });
        Ok(p)
    }

    pub async fn delete_project(&self, id: &str) -> anyhow::Result<bool> {
        let deleted = self.library.write().await.delete(id)?;
        if deleted {
            // Unload it from every channel showing it.
            for ch in self.channels.values() {
                let mut pid = ch.project_id.write().await;
                if pid.as_deref() == Some(id) {
                    *pid = None;
                    ch.state.write().await.layers.clear();
                }
            }
            self.persist_loaded_projects().await;
            let _ = self.events.send(Event::ProjectDeleted { id: id.into() });
            let _ = self.events.send(Event::Channels {
                channels: self.channel_infos().await,
            });
        }
        Ok(deleted)
    }

    /// Loads a project on a channel (clears what is on air).
    pub async fn load_project(
        &self,
        channel_id: &str,
        project_id: Option<String>,
    ) -> Result<(), String> {
        let ch = self.channel(channel_id).ok_or("no such channel")?;
        if let Some(pid) = &project_id {
            if self.project(pid).await.is_none() {
                return Err("no such project".into());
            }
        }
        *ch.project_id.write().await = project_id;
        ch.state.write().await.layers.clear();
        self.persist_loaded_projects().await;
        self.broadcast_channel(ch).await;
        let _ = self.events.send(Event::Channels {
            channels: self.channel_infos().await,
        });
        Ok(())
    }

    /// Re-keys graphics on air after zones of a project changed layer.
    pub async fn move_layers(&self, project_id: &str, moves: &[(u32, u32)]) {
        for ch in self.channels.values() {
            if ch.project_id.read().await.as_deref() != Some(project_id) {
                continue;
            }
            {
                let mut st = ch.state.write().await;
                let mut taken: Vec<(u32, cg_core::PlayoutItem)> = moves
                    .iter()
                    .filter_map(|(from, to)| st.layers.remove(from).map(|i| (*to, i)))
                    .collect();
                for (to, item) in taken.drain(..) {
                    st.layers.insert(to, item);
                }
            }
            self.broadcast_channel(ch).await;
        }
    }

    /// Remembers which project each channel shows across restarts.
    async fn persist_loaded_projects(&self) {
        let mut cfg = ServerConfig::load(&self.data_dir);
        for c in cfg.channels.iter_mut() {
            if let Some(rt) = self.channels.get(&c.id) {
                c.project_id = rt.project_id.read().await.clone();
            }
        }
        if let Err(e) = cfg.save(&self.data_dir) {
            tracing::warn!("cannot save loaded projects: {e}");
        }
    }

    pub async fn broadcast_channel(&self, ch: &ChannelRt) {
        let state = ch.state.read().await.clone();
        let _ = self.events.send(Event::Channel {
            channel_id: ch.config.id.clone(),
            state,
            server_time: now_ms(),
        });
    }

    pub async fn command(&self, channel_id: &str, cmd: Command) -> Result<ChannelState, String> {
        let ch = self.channel(channel_id).ok_or("no such channel")?;
        let pid = ch
            .project_id
            .read()
            .await
            .clone()
            .ok_or("no project loaded on this channel")?;
        let project = self
            .project(&pid)
            .await
            .ok_or("the loaded project no longer exists")?;
        let snapshot = {
            let mut st = ch.state.write().await;
            st.apply(&project, cmd).map_err(|e| e.to_string())?;
            st.clone()
        };
        let _ = self.events.send(Event::Channel {
            channel_id: channel_id.into(),
            state: snapshot.clone(),
            server_time: now_ms(),
        });
        Ok(snapshot)
    }
}

/// Resolves once the watched flag becomes true (or its sender is gone).
pub async fn until_true(mut rx: watch::Receiver<bool>) {
    while !*rx.borrow_and_update() {
        if rx.changed().await.is_err() {
            return;
        }
    }
}
