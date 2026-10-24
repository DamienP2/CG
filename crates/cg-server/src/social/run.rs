//! Runs the connections: one task per enabled connection, restarted when it
//! changes, reconnecting with a growing delay when the platform fails.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::task::{AbortHandle, JoinSet};

use super::{Author, Hub, Message, Platform, SocialSource, Status};
use crate::state::{now_ms, Shared};

/// The connections that read their platform: the enabled ones.
pub fn wanted(all: &[SocialSource]) -> Vec<SocialSource> {
    all.iter().filter(|s| s.enabled).cloned().collect()
}

pub async fn run(shared: Shared) {
    supervise(shared.social.clone()).await
}

async fn supervise(hub: Arc<Hub>) {
    // Dropped with this task (engine restart): every connector stops.
    let mut set = JoinSet::new();
    let mut tasks: HashMap<String, (String, AbortHandle)> = HashMap::new();
    loop {
        let changed = hub.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        while set.try_join_next().is_some() {}
        let want = wanted(&hub.all());
        tasks.retain(|id, (print, task)| {
            let keep = want.iter().any(|s| &s.id == id && &fingerprint(s) == print);
            if !keep {
                task.abort();
                if hub.get(id).is_some() {
                    hub.set_status(id, |st| {
                        *st = Status {
                            last_at: st.last_at,
                            ..Default::default()
                        }
                    });
                }
            }
            keep
        });
        for s in want {
            if !tasks.contains_key(&s.id) {
                let print = fingerprint(&s);
                let id = s.id.clone();
                let task = set.spawn(keep(hub.clone(), s));
                tasks.insert(id, (print, task));
            }
        }
        changed.await;
    }
}

fn fingerprint(s: &SocialSource) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// Reads a connection's platform for good, reconnecting after a failure.
async fn keep(hub: Arc<Hub>, src: SocialSource) {
    let mut backoff = 2;
    loop {
        let started = Instant::now();
        let r = match src.platform {
            Platform::Twitch => super::twitch::run(&hub, &src).await,
            Platform::Youtube => super::youtube::run(&hub, &src).await,
            Platform::Facebook => super::meta::facebook(&hub, &src).await,
            Platform::Instagram => super::meta::instagram(&hub, &src).await,
            Platform::X => super::x::run(&hub, &src).await,
            Platform::Tiktok | Platform::Whatsapp | Platform::Sms => {
                super::webhooks::watch(&hub, &src).await
            }
        };
        if started.elapsed() > Duration::from_secs(120) {
            backoff = 2;
        }
        match r {
            // Asked to reconnect (Twitch RECONNECT).
            Ok(()) => tokio::time::sleep(Duration::from_secs(1)).await,
            Err(e) => {
                tracing::debug!(source = %src.id, "social: {e}");
                hub.set_status(&src.id, |st| {
                    st.connected = false;
                    st.off_air = false;
                    st.error = Some(e);
                });
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(120);
            }
        }
    }
}

/// A setting, trimmed ("" when not set).
pub(super) fn setting<'a>(src: &'a SocialSource, key: &str) -> &'a str {
    src.settings.get(key).map_or("", |v| v.trim())
}

/// Reading works (`off_air`: but no live is running).
pub(super) fn connected(hub: &Hub, src: &SocialSource, off_air: bool) {
    hub.set_status(&src.id, |st| {
        st.connected = true;
        st.off_air = off_air;
        st.error = None;
    });
}

/// A message of the connection, arrived now.
pub(super) fn message(src: &SocialSource, id: &str, author: Author, text: &str) -> Message {
    Message {
        id: format!("{}:{id}", src.id),
        source_id: src.id.clone(),
        platform: src.platform,
        author,
        text: text.trim().to_string(),
        photos: vec![],
        at: now_ms(),
        amount: String::new(),
        url: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn a_disabled_connection_does_not_run() {
        let s = |id: &str, enabled| SocialSource {
            id: id.into(),
            name: id.into(),
            platform: Platform::Twitch,
            enabled,
            settings: BTreeMap::from([("channel".into(), "lefigaro_live".into())]),
        };
        let want = wanted(&[s("on", true), s("off", false)]);
        assert_eq!(want.len(), 1);
        assert_eq!(want[0].id, "on");
    }

    #[tokio::test]
    async fn only_enabled_connections_are_started_and_a_change_restarts_them() {
        let dir = std::env::temp_dir().join(format!("social-{}", uuid::Uuid::new_v4().simple()));
        let hub = Arc::new(Hub::load(&dir));
        let wa = |id: &str, enabled| SocialSource {
            id: id.into(),
            name: id.into(),
            platform: Platform::Whatsapp,
            enabled,
            settings: BTreeMap::new(),
        };
        hub.put(wa("on", true)).unwrap();
        hub.put(wa("off", false)).unwrap();
        let task = tokio::spawn(supervise(hub.clone()));
        let status = |id: &str| {
            hub.list()
                .into_iter()
                .find(|s| s.source.id == id)
                .unwrap()
                .status
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(status("on").connected);
        assert!(!status("off").connected);
        hub.put(wa("on", false)).unwrap();
        hub.put(wa("off", true)).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!status("on").connected);
        assert!(status("off").connected);
        task.abort();
        let _ = std::fs::remove_dir_all(dir);
    }
}
