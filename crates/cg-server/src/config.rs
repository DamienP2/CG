//! Server settings editable from the web UI (`<data>/config.json`).

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::Path;

use cg_core::FrameRate;
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

/// Another shape of the same program (e.g. 9:16 for social media): same
/// playout, its own size and outputs. The project format closest in aspect
/// ratio is used, so one take drives every rendition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendition {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub outputs: OutputsConfig,
}

/// One independent output channel (a studio, a control room…): its own
/// playout clock, video format, baseband outputs and HTML5 output page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfig {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
    /// Show project currently loaded on the channel.
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub outputs: OutputsConfig,
    /// Extra renditions (9:16, 1:1…) driven by the same playout.
    #[serde(default)]
    pub renditions: Vec<Rendition>,
}

impl ChannelConfig {
    /// (rendition id, width, height, outputs): the main picture ("main")
    /// then the extra renditions.
    pub fn pictures(&self) -> Vec<(&str, u32, u32, &OutputsConfig)> {
        std::iter::once(("main", self.width, self.height, &self.outputs))
            .chain(
                self.renditions
                    .iter()
                    .map(|r| (r.id.as_str(), r.width, r.height, &r.outputs)),
            )
            .collect()
    }

    pub fn new(id: &str, name: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::new(50, 1),
            project_id: None,
            outputs: OutputsConfig::default(),
            renditions: Vec::new(),
        }
    }
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
    /// Let HTML5 output pages (OBS / vMix / CasparCG browser sources) play
    /// without logging in.
    #[serde(default = "yes")]
    pub public_outputs: bool,
    /// Default IANA time zone of clocks ("" = the server's zone).
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub channels: Vec<ChannelConfig>,
    /// Pre-0.2 single-channel outputs, moved into the first channel on load.
    #[serde(default, skip_serializing)]
    outputs: Option<OutputsConfig>,
}

fn default_name() -> String {
    "Pulse CG".into()
}

fn yes() -> bool {
    true
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            name: default_name(),
            bind: None,
            public_outputs: true,
            timezone: String::new(),
            channels: Vec::new(),
            outputs: None,
        }
    }
}

const FILE: &str = "config.json";

impl ServerConfig {
    /// Loads `config.json` (migrating older layouts). The returned config
    /// always has at least one channel.
    pub fn load(data_dir: &Path) -> Self {
        let mut c = match std::fs::read(data_dir.join(FILE)) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::error!("invalid {FILE} ({e}); using defaults");
                Self::default()
            }),
            Err(_) => {
                let mut c = Self::default();
                if let Ok(bytes) = std::fs::read(data_dir.join("outputs.json")) {
                    match serde_json::from_slice::<OutputsConfig>(&bytes) {
                        Ok(o) => c.outputs = Some(o),
                        Err(e) => tracing::error!("invalid outputs.json: {e}"),
                    }
                }
                c
            }
        };
        let legacy = c.outputs.take();
        if c.channels.is_empty() {
            let mut ch = ChannelConfig::new("main", "Channel 1");
            ch.outputs = legacy.unwrap_or_default();
            c.channels.push(ch);
            let _ = c.save(data_dir);
        } else if let Some(o) = legacy {
            c.channels[0].outputs = o;
            let _ = c.save(data_dir);
        }
        c
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
        if self.bind.is_some_and(|b| b.port() == 0) {
            return Err("port 0 is not allowed".into());
        }
        if !self.timezone.trim().is_empty()
            && jiff::tz::TimeZone::get(self.timezone.trim()).is_err()
        {
            return Err(format!("unknown time zone `{}`", self.timezone));
        }
        if self.channels.is_empty() {
            return Err("at least one channel is required".into());
        }
        let mut ids = HashSet::new();
        for ch in &self.channels {
            let valid_id = !ch.id.is_empty()
                && ch
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            if !valid_id || !ids.insert(ch.id.as_str()) {
                return Err(format!(
                    "channel ids must be unique and use letters, digits, - or _ (`{}`)",
                    ch.id
                ));
            }
            if ch.name.trim().is_empty() {
                return Err("every channel needs a name".into());
            }
            if !(16..=7680).contains(&ch.width) || !(16..=4320).contains(&ch.height) {
                return Err(format!("channel `{}`: invalid resolution", ch.name));
            }
            if ch.frame_rate.num == 0 || ch.frame_rate.den == 0 || ch.frame_rate.as_f64() > 120.0 {
                return Err(format!("channel `{}`: invalid frame rate", ch.name));
            }
            let mut rendition_ids = HashSet::from(["main"]);
            for r in &ch.renditions {
                let ok = !r.id.is_empty()
                    && r.id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
                if !ok || !rendition_ids.insert(r.id.as_str()) {
                    return Err(format!(
                        "channel `{}`: rendition ids must be unique (letters, digits, - or _)",
                        ch.name
                    ));
                }
                if !(16..=7680).contains(&r.width) || !(16..=7680).contains(&r.height) {
                    return Err(format!("rendition `{}`: invalid resolution", r.name));
                }
            }
            let mut names = HashSet::new();
            for (_, _, _, outputs) in ch.pictures() {
                for o in &outputs.st2110 {
                    if o.name.trim().is_empty() || !names.insert(o.name.as_str()) {
                        return Err(format!(
                            "channel `{}`: output names must be unique and non-empty",
                            ch.name
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
                for o in &outputs.sdi {
                    if o.name.trim().is_empty() || !names.insert(o.name.as_str()) {
                        return Err(format!(
                            "channel `{}`: output names must be unique and non-empty",
                            ch.name
                        ));
                    }
                }
            }
        }
        // The same multicast destination on two channels is always a mistake.
        let mut dests = HashSet::new();
        for o in self
            .channels
            .iter()
            .flat_map(|c| c.pictures())
            .flat_map(|(_, _, _, outputs)| &outputs.st2110)
        {
            for d in std::iter::once(o.fill).chain(o.key) {
                if !dests.insert(d) {
                    return Err(format!("destination {d} is used by two outputs"));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cg-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migrates_outputs_json_into_first_channel() {
        let dir = tmp("outputs");
        std::fs::write(
            dir.join("outputs.json"),
            r#"{"st2110":[{"name":"CG1","fill":"239.1.1.1:5004"}]}"#,
        )
        .unwrap();
        let c = ServerConfig::load(&dir);
        assert_eq!(c.channels.len(), 1);
        assert_eq!(c.channels[0].outputs.st2110[0].name, "CG1");
        assert_eq!(ServerConfig::load(&dir), c);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_v01_config() {
        let dir = tmp("v01");
        std::fs::write(dir.join(FILE), r#"{"name":"Régie","outputs":{"st2110":[{"name":"A","fill":"239.1.1.1:5004"}],"sdi":[]}}"#).unwrap();
        let c = ServerConfig::load(&dir);
        assert_eq!(c.name, "Régie");
        assert_eq!(c.channels[0].outputs.st2110[0].name, "A");
        let raw = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(
            !raw.contains("\"outputs\":{\"st2110\":[{\"name\":\"A\"") || raw.contains("channels")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_shared_destinations() {
        let mut c = ServerConfig::default();
        let o: St2110Config =
            serde_json::from_str(r#"{"name":"A","fill":"239.1.1.1:5004"}"#).unwrap();
        for id in ["a", "b"] {
            let mut ch = ChannelConfig::new(id, id);
            ch.outputs.st2110.push(o.clone());
            c.channels.push(ch);
        }
        assert!(c.validate().unwrap_err().contains("used by two outputs"));
    }
}
