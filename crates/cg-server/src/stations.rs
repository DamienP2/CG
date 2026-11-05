//! Production stations: the computers whose Operator really goes on air.
//!
//! An admin declares a computer from that computer: the server gives its
//! browser a secret cookie and keeps only its hash, in
//! `<data>/stations.json`. A person in the web app on any other computer
//! drives a simulation of the channel (see `crate::sim`); API keys, MOS,
//! programmed takes and the Premiere panel are not concerned.

use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

/// The cookie holding a station's secret.
pub const COOKIE: &str = "cg_station";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    pub id: String,
    pub name: String,
    /// SHA-256 of its secret (hex).
    hash: String,
    pub created_at: i64,
}

/// A station as the web app sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// Last request from it (ms), since the server started.
    pub last_seen: Option<i64>,
}

pub struct Stations {
    path: PathBuf,
    list: RwLock<Vec<Station>>,
    seen: Mutex<HashMap<String, i64>>,
}

fn hash(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Stations {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("stations.json");
        let list = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            list: RwLock::new(list),
            seen: Default::default(),
        }
    }

    fn save(&self, list: &[Station]) -> anyhow::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<View> {
        let seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        self.list
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|s| View {
                id: s.id.clone(),
                name: s.name.clone(),
                created_at: s.created_at,
                last_seen: seen.get(&s.id).copied(),
            })
            .collect()
    }

    /// Declares a station: its view and the secret its browser keeps.
    pub fn create(&self, name: &str) -> anyhow::Result<(View, String)> {
        let secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let st = Station {
            id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
            name: name.trim().to_string(),
            hash: hash(&secret),
            created_at: crate::state::now_ms(),
        };
        let mut list = self.list.write().unwrap_or_else(|e| e.into_inner());
        let mut next = list.clone();
        next.push(st.clone());
        self.save(&next)?;
        *list = next;
        Ok((
            View {
                id: st.id,
                name: st.name,
                created_at: st.created_at,
                last_seen: None,
            },
            secret,
        ))
    }

    pub fn rename(&self, id: &str, name: &str) -> anyhow::Result<bool> {
        let mut list = self.list.write().unwrap_or_else(|e| e.into_inner());
        let mut next = list.clone();
        let Some(s) = next.iter_mut().find(|s| s.id == id) else {
            return Ok(false);
        };
        s.name = name.trim().to_string();
        self.save(&next)?;
        *list = next;
        Ok(true)
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<bool> {
        let mut list = self.list.write().unwrap_or_else(|e| e.into_inner());
        let next: Vec<Station> = list.iter().filter(|s| s.id != id).cloned().collect();
        if next.len() == list.len() {
            return Ok(false);
        }
        self.save(&next)?;
        *list = next;
        Ok(true)
    }

    /// The station of this secret (and it was seen now).
    pub fn of_secret(&self, secret: &str) -> Option<View> {
        let h = hash(secret);
        let st = self
            .list
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|s| s.hash == h)
            .cloned()?;
        let now = crate::state::now_ms();
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(st.id.clone(), now);
        Some(View {
            id: st.id,
            name: st.name,
            created_at: st.created_at,
            last_seen: Some(now),
        })
    }

    /// The station a request comes from.
    pub fn of_request(&self, parts: &Parts) -> Option<View> {
        secret_from(parts).and_then(|s| self.of_secret(&s))
    }
}

/// The station secret of a request (its cookie).
pub fn secret_from(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
}

/// The cookie that makes a browser a station (`""`, `0`: forgets it).
pub fn cookie(secret: &str, max_age: i64, secure: bool) -> String {
    format!(
        "{COOKIE}={secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

/// The production station a request comes from, if any.
pub struct OnStation(pub Option<View>);

impl FromRequestParts<crate::state::Shared> for OnStation {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        s: &crate::state::Shared,
    ) -> Result<Self, Self::Rejection> {
        Ok(OnStation(s.stations.of_request(parts)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_station_is_known_by_its_secret_only() {
        let dir = std::env::temp_dir().join(format!("cg-stations-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let st = Stations::load(&dir);
        let (v, secret) = st.create(" Régie 1 ").unwrap();
        assert_eq!(v.name, "Régie 1");
        assert_eq!(st.of_secret(&secret).map(|s| s.id), Some(v.id.clone()));
        assert!(st.of_secret("guess").is_none());
        // Kept on disk without the secret.
        let file = std::fs::read_to_string(dir.join("stations.json")).unwrap();
        assert!(!file.contains(&secret));
        let again = Stations::load(&dir);
        assert!(again.of_secret(&secret).is_some());
        assert!(again.remove(&v.id).unwrap());
        assert!(again.of_secret(&secret).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
