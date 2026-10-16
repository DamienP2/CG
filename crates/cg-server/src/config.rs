//! Server settings editable from the web UI (`<data>/config.json`).

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::Path;

use cg_output::sdi::SdiConfig;
use cg_output::st2110::St2110Config;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputsConfig {
    #[serde(default)]
    pub st2110: Vec<St2110Config>,
    #[serde(default)]
    pub sdi: Vec<SdiConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// Friendly name shown in the UI and the tray app.
    #[serde(default = "default_name")]
    pub name: String,
    /// Web UI / API listening address. `None` = installer / CLI default.
    #[serde(default)]
    pub bind: Option<SocketAddr>,
    #[serde(default)]
    pub outputs: OutputsConfig,
}

fn default_name() -> String {
    "Pulse CG".into()
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            name: default_name(),
            bind: None,
            outputs: OutputsConfig::default(),
        }
    }
}

const FILE: &str = "config.json";

impl ServerConfig {
    /// Loads `config.json`, migrating the older `outputs.json` if present.
    pub fn load(data_dir: &Path) -> Self {
        match std::fs::read(data_dir.join(FILE)) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(c) => return c,
                Err(e) => tracing::error!("invalid {FILE} ({e}); using defaults"),
            },
            Err(_) => {
                if let Ok(bytes) = std::fs::read(data_dir.join("outputs.json")) {
                    match serde_json::from_slice::<OutputsConfig>(&bytes) {
                        Ok(outputs) => {
                            tracing::info!("migrating outputs.json into {FILE}");
                            let c = Self {
                                outputs,
                                ..Self::default()
                            };
                            let _ = c.save(data_dir);
                            return c;
                        }
                        Err(e) => tracing::error!("invalid outputs.json: {e}"),
                    }
                }
            }
        }
        Self::default()
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let tmp = data_dir.join("config.json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(tmp, data_dir.join(FILE))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("the server name cannot be empty".into());
        }
        if let Some(b) = self.bind {
            if b.port() == 0 {
                return Err("port 0 is not allowed".into());
            }
        }
        let mut names = HashSet::new();
        for o in &self.outputs.st2110 {
            if o.name.trim().is_empty() || !names.insert(o.name.as_str()) {
                return Err(format!(
                    "output names must be unique and non-empty (`{}`)",
                    o.name
                ));
            }
            if o.fill.port() == 0 || o.key.is_some_and(|k| k.port() == 0) {
                return Err(format!(
                    "output `{}`: a destination port is missing",
                    o.name
                ));
            }
            if Some(o.fill) == o.key {
                return Err(format!(
                    "output `{}`: fill and key must use different destinations",
                    o.name
                ));
            }
        }
        for o in &self.outputs.sdi {
            if o.name.trim().is_empty() || !names.insert(o.name.as_str()) {
                return Err(format!(
                    "output names must be unique and non-empty (`{}`)",
                    o.name
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_outputs_json() {
        let dir = std::env::temp_dir().join(format!("cg-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("outputs.json"),
            r#"{"st2110":[{"name":"CG1","fill":"239.1.1.1:5004"}]}"#,
        )
        .unwrap();
        let c = ServerConfig::load(&dir);
        assert_eq!(c.outputs.st2110[0].name, "CG1");
        assert!(dir.join(FILE).exists());
        assert_eq!(ServerConfig::load(&dir), c);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_duplicate_names() {
        let mut c = ServerConfig::default();
        let o: St2110Config =
            serde_json::from_str(r#"{"name":"A","fill":"239.1.1.1:5004"}"#).unwrap();
        c.outputs.st2110 = vec![o.clone(), o];
        assert!(c.validate().is_err());
    }
}
