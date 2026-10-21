//! The video hardware of the server (Hardware page): DeckLink cards and
//! what each SDI connector does, and the ST 2110 flows with their multicast
//! addresses. The Video streams destinations (and SDI / ST 2110 inputs)
//! name one of these by id; `ServerConfig::normalize` copies the actual
//! parameters into them, so the engine opens them as before.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddrV4};

use cg_output::st2110::St2110Encoding;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareConfig {
    #[serde(default)]
    pub sdi: SdiHardware,
    #[serde(default)]
    pub st2110: St2110Hardware,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdiHardware {
    #[serde(default)]
    pub cards: Vec<SdiCard>,
    /// Fill (+ key) pairs the channels send to.
    #[serde(default)]
    pub outputs: Vec<SdiOutputDef>,
    #[serde(default)]
    pub inputs: Vec<SdiInputDef>,
}

/// A DeckLink card, as declared by the admin (cards cannot be listed
/// without the DeckLink SDK).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdiCard {
    pub id: String,
    pub name: String,
    /// `miniMonitor`, `miniRecorder`, `sdi4k`, `duo2`, `quad2`, `8kPro`, `other`.
    #[serde(default = "other")]
    pub model: String,
    /// Index of the card's first device in Desktop Video (0 = first).
    #[serde(default)]
    pub device: u32,
    /// Its SDI connectors, in order (their role comes from the outputs and
    /// inputs using them).
    #[serde(default)]
    pub connectors: Vec<SdiConnector>,
}

fn other() -> String {
    "other".into()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdiConnector {
    /// What it is wired to ("Mixer key 3"…).
    #[serde(default)]
    pub name: String,
}

impl SdiCard {
    /// The Desktop Video device of a connector: cards with several
    /// connectors show one device per connector, the others one in all.
    pub fn device_of(&self, connector: u32) -> u32 {
        match self.model.as_str() {
            "miniMonitor" | "miniRecorder" | "sdi4k" => self.device,
            _ => self.device + connector,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdiMode {
    /// Fill and key on two connectors, for an external keyer.
    #[default]
    ExternalKey,
    /// The card's internal keyer, over its SDI input.
    InternalKey,
    FillOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdiOutputDef {
    pub id: String,
    pub name: String,
    pub card: String,
    /// Connector of the fill (0 = first).
    #[serde(default)]
    pub fill: u32,
    /// Connector of the key (external keyer).
    #[serde(default)]
    pub key: Option<u32>,
    #[serde(default)]
    pub mode: SdiMode,
    #[serde(default)]
    pub genlock: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdiInputDef {
    pub id: String,
    pub name: String,
    pub card: String,
    #[serde(default)]
    pub connector: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct St2110Hardware {
    #[serde(default)]
    pub flows: Vec<St2110Flow>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowDirection {
    #[default]
    Output,
    /// Received (not implemented by the server yet).
    Input,
}

/// An ST 2110 flow: the multicast destinations of a sender (or the groups
/// a receiver joins).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct St2110Flow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub direction: FlowDirection,
    #[serde(default)]
    pub encoding: St2110Encoding,
    pub fill: SocketAddrV4,
    #[serde(default)]
    pub key: Option<SocketAddrV4>,
    #[serde(default)]
    pub interface: Option<Ipv4Addr>,
    #[serde(default = "default_ttl")]
    pub ttl: u32,
    #[serde(default = "default_pt")]
    pub payload_type: u8,
}

fn default_ttl() -> u32 {
    32
}
fn default_pt() -> u8 {
    96
}

/// `kind-1`, `kind-2`…: the first id not taken.
fn next_id(kind: &str, taken: &HashSet<String>) -> String {
    let mut n = 1;
    while taken.contains(&format!("{kind}-{n}")) {
        n += 1;
    }
    format!("{kind}-{n}")
}

impl HardwareConfig {
    /// Ids for everything (unique per list).
    pub fn ensure_ids(&mut self) {
        fn fill<'a>(kind: &str, ids: impl Iterator<Item = &'a mut String>) {
            let mut taken = HashSet::new();
            for id in ids {
                if id.is_empty() || !taken.insert(id.clone()) {
                    *id = next_id(kind, &taken);
                    taken.insert(id.clone());
                }
            }
        }
        fill("card", self.sdi.cards.iter_mut().map(|c| &mut c.id));
        fill("sdi-out", self.sdi.outputs.iter_mut().map(|c| &mut c.id));
        fill("sdi-in", self.sdi.inputs.iter_mut().map(|c| &mut c.id));
        fill("flow", self.st2110.flows.iter_mut().map(|c| &mut c.id));
    }

    pub fn card(&self, id: &str) -> Option<&SdiCard> {
        self.sdi.cards.iter().find(|c| c.id == id)
    }

    /// The settings of an SDI destination from its Hardware output.
    pub fn apply_sdi(&self, o: &mut cg_output::sdi::SdiConfig) {
        let Some(def) = self.sdi.outputs.iter().find(|d| d.id == o.hardware) else {
            return;
        };
        if let Some(card) = self.card(&def.card) {
            o.device = card.device_of(def.fill);
        }
        o.external_key = def.mode != SdiMode::InternalKey;
        o.fill_only = def.mode == SdiMode::FillOnly;
        o.genlock = def.genlock;
    }

    /// The settings of an ST 2110 destination from its Hardware flow.
    pub fn apply_st2110(&self, o: &mut cg_output::st2110::St2110Config) {
        let Some(f) = self.st2110.flows.iter().find(|f| f.id == o.hardware) else {
            return;
        };
        o.encoding = f.encoding;
        o.fill = f.fill;
        o.key = if f.encoding == St2110Encoding::FillKey {
            f.key
        } else {
            None
        };
        o.interface = f.interface;
        o.ttl = f.ttl;
        o.payload_type = f.payload_type;
    }

    /// An SDI destination saved before the Hardware page: its card and
    /// output are declared from its own settings.
    pub fn adopt_sdi(&mut self, o: &mut cg_output::sdi::SdiConfig) {
        let mode = if o.fill_only {
            SdiMode::FillOnly
        } else if o.external_key {
            SdiMode::ExternalKey
        } else {
            SdiMode::InternalKey
        };
        let keyed = mode == SdiMode::ExternalKey;
        let card = self.new_card(o.device, if keyed { 2 } else { 1 });
        let taken = self.sdi.outputs.iter().map(|d| d.id.clone()).collect();
        let id = next_id("sdi-out", &taken);
        self.sdi.outputs.push(SdiOutputDef {
            id: id.clone(),
            name: o.name.clone(),
            card,
            fill: 0,
            key: keyed.then_some(1),
            mode,
            genlock: o.genlock,
        });
        o.hardware = id;
    }

    /// An SDI input saved before the Hardware page.
    pub fn adopt_sdi_input(&mut self, i: &mut crate::inputs::InputConfig) {
        let card = self.new_card(i.device, 1);
        let taken = self.sdi.inputs.iter().map(|d| d.id.clone()).collect();
        let id = next_id("sdi-in", &taken);
        self.sdi.inputs.push(SdiInputDef {
            id: id.clone(),
            name: i.name.clone(),
            card,
            connector: 0,
        });
        i.hardware = id;
    }

    fn new_card(&mut self, device: u32, connectors: usize) -> String {
        let taken = self.sdi.cards.iter().map(|c| c.id.clone()).collect();
        let id = next_id("card", &taken);
        self.sdi.cards.push(SdiCard {
            id: id.clone(),
            name: format!("DeckLink #{device}"),
            model: other(),
            device,
            connectors: vec![SdiConnector::default(); connectors],
        });
        id
    }

    /// An ST 2110 destination saved before the Hardware page: its flow is
    /// declared from its own settings.
    pub fn adopt_st2110(&mut self, o: &mut cg_output::st2110::St2110Config) {
        let taken = self.st2110.flows.iter().map(|f| f.id.clone()).collect();
        let id = next_id("flow", &taken);
        self.st2110.flows.push(St2110Flow {
            id: id.clone(),
            name: o.name.clone(),
            direction: FlowDirection::Output,
            encoding: o.encoding,
            fill: o.fill,
            key: o.key,
            interface: o.interface,
            ttl: o.ttl,
            payload_type: o.payload_type,
        });
        o.hardware = id;
    }

    pub fn validate(&self) -> Result<(), String> {
        let unique = |what: &str, ids: Vec<&str>| -> Result<(), String> {
            let mut seen = HashSet::new();
            for id in ids {
                if id.is_empty() || !seen.insert(id) {
                    return Err(format!("Hardware: {what} ids must be unique"));
                }
            }
            Ok(())
        };
        unique(
            "card",
            self.sdi.cards.iter().map(|c| c.id.as_str()).collect(),
        )?;
        unique(
            "SDI output",
            self.sdi.outputs.iter().map(|c| c.id.as_str()).collect(),
        )?;
        unique(
            "SDI input",
            self.sdi.inputs.iter().map(|c| c.id.as_str()).collect(),
        )?;
        unique(
            "ST 2110 flow",
            self.st2110.flows.iter().map(|c| c.id.as_str()).collect(),
        )?;
        for c in &self.sdi.cards {
            if c.connectors.is_empty() || c.connectors.len() > 16 {
                return Err(format!("card `{}`: 1 to 16 connectors", c.name));
            }
        }
        // Each connector does one thing.
        let mut used = HashSet::new();
        let mut take = |name: &str, card: &str, connector: u32| -> Result<(), String> {
            let c = self
                .card(card)
                .ok_or_else(|| format!("SDI `{name}`: its card is not declared"))?;
            if connector as usize >= c.connectors.len() {
                return Err(format!(
                    "SDI `{name}`: card `{}` has no connector {}",
                    c.name,
                    connector + 1
                ));
            }
            if !used.insert((card.to_string(), connector)) {
                return Err(format!(
                    "card `{}`: connector {} is used twice",
                    c.name,
                    connector + 1
                ));
            }
            Ok(())
        };
        for o in &self.sdi.outputs {
            if o.name.trim().is_empty() {
                return Err("every SDI output needs a name".into());
            }
            take(&o.name, &o.card, o.fill)?;
            if let Some(k) = o.key.filter(|_| o.mode == SdiMode::ExternalKey) {
                take(&o.name, &o.card, k)?;
            }
        }
        for i in &self.sdi.inputs {
            if i.name.trim().is_empty() {
                return Err("every SDI input needs a name".into());
            }
            take(&i.name, &i.card, i.connector)?;
        }
        let mut dests = HashSet::new();
        for f in &self.st2110.flows {
            if f.name.trim().is_empty() {
                return Err("every ST 2110 flow needs a name".into());
            }
            let key = f.key.filter(|_| f.encoding == St2110Encoding::FillKey);
            if f.fill.port() == 0 || key.is_some_and(|k| k.port() == 0) {
                return Err(format!("flow `{}`: a port is missing", f.name));
            }
            if key == Some(f.fill) {
                return Err(format!(
                    "flow `{}`: fill and key must use different destinations",
                    f.name
                ));
            }
            if f.direction == FlowDirection::Output {
                for d in std::iter::once(f.fill).chain(key) {
                    if !dests.insert(d) {
                        return Err(format!("destination {d} is used by two flows"));
                    }
                }
            }
        }
        Ok(())
    }
}

// ------------------------------------------------------------- detection --

/// `GET /api/hardware`: what this machine has, as far as it can be told
/// without the DeckLink SDK.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    /// Blackmagic Desktop Video (the DeckLink driver) is installed.
    pub desktop_video: bool,
    /// Where it was found.
    pub desktop_video_path: Option<String>,
    /// This server can drive DeckLink cards (built with the SDK).
    pub decklink_support: bool,
    /// This server receives ST 2110.
    pub st2110_receive: bool,
    pub interfaces: Vec<NetInterface>,
    pub os: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInterface {
    pub name: String,
    pub ip: String,
    pub loopback: bool,
}

/// The places Desktop Video installs its driver library.
fn desktop_video_paths() -> Vec<std::path::PathBuf> {
    let p = |s: &str| std::path::PathBuf::from(s);
    match std::env::consts::OS {
        "macos" => vec![
            p("/Library/Frameworks/DeckLinkAPI.framework"),
            p("/Library/Application Support/Blackmagic Design/Desktop Video"),
            p("/Library/Application Support/Blackmagic Design"),
        ],
        "windows" => {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            vec![std::path::Path::new(&root).join(r"System32\DeckLinkAPI64.dll")]
        }
        _ => vec![
            p("/usr/lib/libDeckLinkAPI.so"),
            p("/usr/lib64/libDeckLinkAPI.so"),
            p("/usr/lib/x86_64-linux-gnu/libDeckLinkAPI.so"),
            p("/usr/lib/aarch64-linux-gnu/libDeckLinkAPI.so"),
        ],
    }
}

pub fn detect() -> HardwareInfo {
    let found = desktop_video_paths().into_iter().find(|p| p.exists());
    let mut interfaces: Vec<NetInterface> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.ip().is_ipv4())
        .map(|i| NetInterface {
            ip: i.ip().to_string(),
            loopback: i.is_loopback(),
            name: i.name,
        })
        .collect();
    interfaces.sort_by(|a, b| (a.loopback, &a.name).cmp(&(b.loopback, &b.name)));
    HardwareInfo {
        desktop_video: found.is_some(),
        desktop_video_path: found.map(|p| p.display().to_string()),
        decklink_support: cg_output::sdi::SUPPORTED,
        st2110_receive: false,
        interfaces,
        os: std::env::consts::OS,
    }
}
