//! What each user sets for themselves, kept in `<data_dir>/prefs/<user>.json`:
//! their keyboard shortcuts in the Operator.

use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::{bad, internal, ApiResult};
use crate::auth::CurrentUser;
use crate::state::Shared;

/// Keys bound to one action ("next", "take:3", "outZone:Bug"…).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub action: String,
    pub keys: Vec<String>,
}

/// A user's shortcuts; `None`: never set (the app's defaults).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Shortcuts {
    #[serde(default)]
    pub bindings: Option<Vec<Binding>>,
}

fn path_of(data_dir: &Path, user: &str) -> PathBuf {
    let safe: String = user
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    data_dir.join("prefs").join(format!("{safe}.json"))
}

/// A user's preferences file (an object; empty when none).
fn read(data_dir: &Path, user: &str) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(path_of(data_dir, user))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write(
    data_dir: &Path,
    user: &str,
    prefs: &serde_json::Map<String, serde_json::Value>,
) -> std::io::Result<()> {
    let path = path_of(data_dir, user);
    std::fs::create_dir_all(path.parent().expect("in a folder"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(prefs)?)?;
    std::fs::rename(tmp, path)
}

fn check(b: &[Binding]) -> Result<(), String> {
    if b.len() > 500 {
        return Err("too many shortcuts".into());
    }
    for x in b {
        if x.action.is_empty() || x.action.len() > 200 {
            return Err("an action needs a name (200 characters at most)".into());
        }
        if x.keys.len() > 16 || x.keys.iter().any(|k| k.is_empty() || k.len() > 60) {
            return Err(format!("wrong keys for {}", x.action));
        }
    }
    Ok(())
}

/// `GET /api/me/shortcuts`.
pub async fn get_shortcuts(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
) -> Json<Shortcuts> {
    let prefs = read(&s.data_dir, &me.id);
    Json(
        prefs
            .get("shortcuts")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default(),
    )
}

/// `PUT /api/me/shortcuts` `{bindings}` (`null`: back to the defaults).
pub async fn put_shortcuts(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(input): Json<Shortcuts>,
) -> ApiResult<Json<Shortcuts>> {
    if let Some(b) = &input.bindings {
        check(b).map_err(bad)?;
    }
    let mut prefs = read(&s.data_dir, &me.id);
    prefs.insert(
        "shortcuts".into(),
        serde_json::to_value(&input).map_err(internal)?,
    );
    write(&s.data_dir, &me.id, &prefs).map_err(internal)?;
    Ok(Json(input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_are_kept_per_user() {
        let dir = std::env::temp_dir().join(format!("cg-prefs-{}", std::process::id()));
        let mut p = serde_json::Map::new();
        let s = Shortcuts {
            bindings: Some(vec![Binding {
                action: "next".into(),
                keys: vec!["F1".into(), "Enter".into()],
            }]),
        };
        p.insert("shortcuts".into(), serde_json::to_value(&s).unwrap());
        write(&dir, "u/../1", &p).unwrap();
        assert!(dir.join("prefs").join("u____1.json").exists());
        let back: Shortcuts =
            serde_json::from_value(read(&dir, "u/../1")["shortcuts"].clone()).unwrap();
        assert_eq!(back, s);
        assert!(read(&dir, "other").is_empty());
        assert!(check(&[Binding {
            action: String::new(),
            keys: vec![]
        }])
        .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
