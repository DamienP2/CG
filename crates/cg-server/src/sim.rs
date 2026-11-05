//! Simulations: what the Operator drives on a computer that is not a
//! production station (`crate::stations`). Each person has their own copy
//! of a channel, with the project they operate: the same playout (pauses,
//! automatic steps, Logic, data), on no output, not in the as-run log, no
//! sound. Its id is `sim~<user>~<channel>`; only its person sees it.

use crate::state::{AppState, ChannelRt, Shared};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

pub const PREFIX: &str = "sim~";

/// The channel part of a simulation without output: the project's own format.
pub const NO_OUTPUT: &str = "-";

/// Dropped after this long without a command or the Operator asking for it.
const IDLE_MS: i64 = 2 * 3600 * 1000;

pub fn id(user: &str, channel: &str) -> String {
    format!("{PREFIX}{user}~{channel}")
}

pub fn is_sim(id: &str) -> bool {
    id.starts_with(PREFIX)
}

/// The person and the channel of a simulation.
pub fn parse(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix(PREFIX)?.split_once('~')
}

/// The channel an id is about: itself, or the one a simulation copies.
pub fn real(id: &str) -> &str {
    parse(id).map_or(id, |(_, c)| c)
}

struct Sim {
    ch: Arc<ChannelRt>,
    touched: AtomicI64,
}

#[derive(Default)]
pub struct Sims(Mutex<HashMap<String, Arc<Sim>>>);

impl Sims {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Sim>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self, id: &str) -> Option<Arc<ChannelRt>> {
        self.map().get(id).map(|s| s.ch.clone())
    }

    pub fn all(&self) -> Vec<Arc<ChannelRt>> {
        self.map().values().map(|s| s.ch.clone()).collect()
    }

    pub fn touch(&self, id: &str) {
        if let Some(s) = self.map().get(id) {
            s.touched.store(crate::state::now_ms(), Ordering::Relaxed);
        }
    }
}

impl AppState {
    /// The simulation of `channel_id` for `user`, running `project_id`
    /// (made, or switched to that project with nothing on air). Without a
    /// channel: in the project's own format.
    pub async fn simulate(
        self: &Shared,
        user: &str,
        channel_id: Option<&str>,
        project_id: &str,
    ) -> Result<String, String> {
        let project = self.project(project_id).await.ok_or("no such project")?;
        let (sid, mut config) = match channel_id {
            Some(c) => (
                id(user, c),
                self.channel(c).ok_or("no such channel")?.config.clone(),
            ),
            None => (
                id(user, NO_OUTPUT),
                serde_json::from_value::<crate::config::ChannelConfig>(serde_json::json!({
                    "id": "",
                    "name": project.name,
                    "width": project.width,
                    "height": project.height,
                    "frameRate": project.frame_rate,
                }))
                .map_err(|e| e.to_string())?,
            ),
        };
        config.id = sid.clone();
        // Another format (a project of another size, without output): made again.
        if self.sims.get(&sid).is_some_and(|ch| {
            (ch.config.width, ch.config.height, ch.config.frame_rate)
                != (config.width, config.height, config.frame_rate)
        }) {
            self.sims.map().remove(&sid);
        }
        if let Some(ch) = self.sims.get(&sid) {
            self.sims.touch(&sid);
            let same = ch.project_id.read().await.as_deref() == Some(project_id);
            if !same {
                *ch.project_id.write().await = Some(project_id.to_string());
                ch.loaded.set(Some(project));
                ch.state.write().await.layers.clear();
                self.broadcast_channel(&ch).await;
            }
            return Ok(sid);
        }
        let ch = Arc::new(ChannelRt {
            config,
            project_id: RwLock::new(Some(project_id.to_string())),
            state: Default::default(),
            loaded: crate::state::Loaded::new(Some(project)),
            published: Default::default(),
            dirty: Default::default(),
            ops: Default::default(),
        });
        let sim = Arc::new(Sim {
            ch: ch.clone(),
            touched: AtomicI64::new(crate::state::now_ms()),
        });
        self.sims.map().insert(sid.clone(), sim.clone());
        tokio::spawn(run(self.clone(), sid.clone(), sim));
        self.broadcast_channel(&ch).await;
        Ok(sid)
    }
}

/// The clock of a simulation: the channel's playout at its rate, until it
/// is dropped (idle, or the engine restarts).
async fn run(s: Shared, sid: String, sim: Arc<Sim>) {
    let fps = sim.ch.config.frame_rate.as_f64().max(1.0);
    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / fps));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let closing = crate::state::until_true(s.closing.subscribe());
    tokio::pin!(closing);
    let mut saved_at = Instant::now();
    loop {
        tokio::select! {
            _ = &mut closing => break,
            _ = tick.tick() => {}
        }
        let idle = crate::state::now_ms() - sim.touched.load(Ordering::Relaxed) > IDLE_MS;
        let current = s.sims.map().get(&sid).is_some_and(|x| Arc::ptr_eq(x, &sim));
        if idle || !current {
            if current {
                s.sims.map().remove(&sid);
            }
            break;
        }
        crate::engine::advance(&s, &sim.ch, &mut saved_at).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_simulation_names_its_person_and_channel() {
        let s = id("u1", "studio-a");
        assert!(is_sim(&s));
        assert_eq!(parse(&s), Some(("u1", "studio-a")));
        assert_eq!(real(&s), "studio-a");
        assert_eq!(real("studio-a"), "studio-a");
        assert!(!is_sim("studio-a"));
        assert_eq!(real(&id("u1", NO_OUTPUT)), NO_OUTPUT);
    }
}
