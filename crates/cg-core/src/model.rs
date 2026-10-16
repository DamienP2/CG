//! Data model shared by the render engine, the server and the web app.
//!
//! Everything is serialised as camelCase JSON; the TypeScript mirror lives in
//! `web/src/engine/types.ts` and must be kept in sync.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::easing::Easing;

/// A frame rate expressed as a rational (e.g. 50/1, 60000/1001).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameRate {
    pub num: u32,
    pub den: u32,
}

impl FrameRate {
    pub const fn new(num: u32, den: u32) -> Self {
        Self { num, den }
    }
    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den.max(1) as f64
    }
    pub fn frame_duration(self) -> std::time::Duration {
        std::time::Duration::from_secs_f64(self.den as f64 / self.num.max(1) as f64)
    }
}

impl Default for FrameRate {
    fn default() -> Self {
        Self::new(50, 1)
    }
}

/// RGBA colour, components in 0..=1 (straight alpha).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Color(pub [f32; 4]);

impl Color {
    pub const TRANSPARENT: Color = Color([0.0, 0.0, 0.0, 0.0]);
    pub const WHITE: Color = Color([1.0, 1.0, 1.0, 1.0]);
    pub const BLACK: Color = Color([0.0, 0.0, 0.0, 1.0]);

    pub fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        Color([r, g, b, a])
    }

    /// Parses `#rgb`, `#rrggbb` or `#rrggbbaa`.
    pub fn from_hex(s: &str) -> Option<Self> {
        let s = s.trim().trim_start_matches('#');
        let hex = |i: usize, len: usize| u8::from_str_radix(s.get(i..i + len)?, 16).ok();
        let (r, g, b, a) = match s.len() {
            3 => {
                let c = |i| hex(i, 1).map(|v| v * 17);
                (c(0)?, c(1)?, c(2)?, 255)
            }
            6 => (hex(0, 2)?, hex(2, 2)?, hex(4, 2)?, 255),
            8 => (hex(0, 2)?, hex(2, 2)?, hex(4, 2)?, hex(6, 2)?),
            _ => return None,
        };
        Some(Color([r, g, b, a].map(|v| v as f32 / 255.0)))
    }
}

/// A value a property can take. Untagged so JSON stays natural:
/// numbers are numbers, colours are `[r,g,b,a]` arrays.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Number(f64),
    Color(Color),
}

impl Value {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            Value::Color(_) => None,
        }
    }
    pub fn as_color(&self) -> Option<Color> {
        match self {
            Value::Color(c) => Some(*c),
            Value::Number(_) => None,
        }
    }
}

/// A keyframe on a property track. The easing describes the curve of the
/// segment that *leaves* this keyframe (After Effects semantics).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub frame: f64,
    pub value: Value,
    #[serde(default)]
    pub easing: Easing,
}

/// Every animatable property. Keep in sync with `AnimProp` in the web app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Prop {
    X,
    Y,
    Width,
    Height,
    AnchorX,
    AnchorY,
    Rotation,
    ScaleX,
    ScaleY,
    Opacity,
    Fill,
    Stroke,
    StrokeWidth,
    CornerRadius,
    FontSize,
    LetterSpacing,
    /// Reveal masks, 0..1 of the layer box, handy for wipes.
    CropLeft,
    CropRight,
    CropTop,
    CropBottom,
}

impl Prop {
    pub const ALL: [Prop; 20] = [
        Prop::X,
        Prop::Y,
        Prop::Width,
        Prop::Height,
        Prop::AnchorX,
        Prop::AnchorY,
        Prop::Rotation,
        Prop::ScaleX,
        Prop::ScaleY,
        Prop::Opacity,
        Prop::Fill,
        Prop::Stroke,
        Prop::StrokeWidth,
        Prop::CornerRadius,
        Prop::FontSize,
        Prop::LetterSpacing,
        Prop::CropLeft,
        Prop::CropRight,
        Prop::CropTop,
        Prop::CropBottom,
    ];

    pub fn is_color(self) -> bool {
        matches!(self, Prop::Fill | Prop::Stroke)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum VerticalAlign {
    Top,
    #[default]
    Middle,
    Bottom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LayerKind {
    Group {
        /// Clip children to the group box (used for wipes / reveals).
        #[serde(default)]
        clip: bool,
    },
    Rect,
    Ellipse,
    #[serde(rename_all = "camelCase")]
    Text {
        /// Text content; `{{key}}` placeholders are replaced by field values.
        text: String,
        font_family: String,
        #[serde(default = "default_weight")]
        font_weight: u16,
        #[serde(default)]
        align: TextAlign,
        #[serde(default)]
        vertical_align: VerticalAlign,
        #[serde(default)]
        uppercase: bool,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        /// Asset path (`/assets/foo.png`) or `{{key}}` binding.
        src: String,
        #[serde(default)]
        fit: ImageFit,
    },
    /// Live clock / countdown / timer.
    #[serde(rename_all = "camelCase")]
    Clock {
        #[serde(default)]
        mode: ClockMode,
        /// Tokens: yyyy yy MM M dd d HH H hh h mm m ss s f A (see widgets.rs).
        #[serde(default = "default_clock_format")]
        format: String,
        /// IANA time zone ("Europe/Paris"); empty = the server's zone.
        #[serde(default)]
        timezone: String,
        /// Countdown: "HH:mm[:ss]" (today) or "yyyy-MM-ddTHH:mm:ss";
        /// timer: duration "[HH:]mm:ss". `{{field}}` allowed.
        #[serde(default)]
        target: String,
        #[serde(flatten)]
        font: FontStyle,
    },
    /// Horizontal crawl: one item per line of `text`, joined by `separator`.
    #[serde(rename_all = "camelCase")]
    Ticker {
        text: String,
        #[serde(default = "default_separator")]
        separator: String,
        /// Pixels per second.
        #[serde(default = "default_ticker_speed")]
        speed: f64,
        #[serde(flatten)]
        font: FontStyle,
    },
    /// Vertical roll (credits, lists): lines scroll upwards.
    #[serde(rename_all = "camelCase")]
    Roll {
        text: String,
        #[serde(default = "default_roll_speed")]
        speed: f64,
        /// Start again from the bottom once everything has scrolled past.
        #[serde(default = "yes", rename = "loop")]
        looping: bool,
        #[serde(flatten)]
        font: FontStyle,
    },
    /// Clock face with hands.
    #[serde(rename_all = "camelCase")]
    AnalogClock {
        /// IANA time zone; empty = the server's zone.
        #[serde(default)]
        timezone: String,
        #[serde(default = "yes")]
        seconds: bool,
        /// Second hand colour (face = fill, hands and ticks = stroke).
        #[serde(default = "default_accent")]
        accent: String,
    },
    /// Number counting from `from` to `to` once on air (scores, results…).
    #[serde(rename_all = "camelCase")]
    Counter {
        #[serde(default)]
        from: String,
        to: String,
        /// Seconds.
        #[serde(default = "default_two")]
        duration: f64,
        #[serde(default)]
        decimals: u8,
        #[serde(default)]
        prefix: String,
        #[serde(default)]
        suffix: String,
        /// Thousands separator.
        #[serde(default = "yes")]
        grouping: bool,
        #[serde(flatten)]
        font: FontStyle,
    },
    /// Horizontal bar filled to `value` / `max`, animated from empty.
    #[serde(rename_all = "camelCase")]
    Progress {
        value: String,
        #[serde(default = "default_hundred")]
        max: String,
        #[serde(default = "default_one")]
        duration: f64,
        /// Colour of the empty part (the bar uses the fill colour).
        #[serde(default = "default_track")]
        track: String,
    },
    /// Shows the lines of `text` one after another with a cross-fade.
    #[serde(rename_all = "camelCase")]
    Rotator {
        text: String,
        /// Seconds per line.
        #[serde(default = "default_four")]
        interval: f64,
        #[serde(default = "default_half")]
        fade: f64,
        #[serde(flatten)]
        font: FontStyle,
    },
    /// Reveals `text` letter by letter.
    #[serde(rename_all = "camelCase")]
    Typewriter {
        text: String,
        /// Characters per second.
        #[serde(default = "default_twenty")]
        speed: f64,
        #[serde(default = "yes")]
        cursor: bool,
        #[serde(flatten)]
        font: FontStyle,
    },
    /// Cycles through images (one asset path per line) with a cross-fade.
    #[serde(rename_all = "camelCase")]
    Slideshow {
        images: String,
        #[serde(default = "default_five")]
        interval: f64,
        #[serde(default = "default_fade")]
        fade: f64,
        #[serde(default)]
        fit: ImageFit,
    },
    /// QR code of `data` (URL, text…); modules use the fill colour.
    #[serde(rename_all = "camelCase")]
    QrCode {
        data: String,
        #[serde(default = "default_white")]
        background: String,
    },
    /// Horizontal bar chart / poll: one "Label: value" per line.
    #[serde(rename_all = "camelCase")]
    BarChart {
        text: String,
        /// Show values as a percentage of the total.
        #[serde(default = "yes")]
        percent: bool,
        #[serde(default = "default_one")]
        duration: f64,
        #[serde(default = "default_track")]
        track: String,
        /// Labels and values (the bars use the fill colour).
        #[serde(default = "default_white")]
        text_color: String,
        #[serde(flatten)]
        font: FontStyle,
    },
}

fn default_accent() -> String {
    "#ff3b5c".into()
}
fn default_track() -> String {
    "#ffffff33".into()
}
fn default_white() -> String {
    "#ffffff".into()
}
fn default_hundred() -> String {
    "100".into()
}
fn default_half() -> f64 {
    0.5
}
fn default_one() -> f64 {
    1.0
}
fn default_two() -> f64 {
    2.0
}
fn default_four() -> f64 {
    4.0
}
fn default_five() -> f64 {
    5.0
}
fn default_fade() -> f64 {
    0.8
}
fn default_twenty() -> f64 {
    20.0
}

/// Font settings shared by the text-based widgets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontStyle {
    #[serde(default = "default_font")]
    pub font_family: String,
    #[serde(default = "default_weight")]
    pub font_weight: u16,
    #[serde(default)]
    pub align: TextAlign,
    #[serde(default)]
    pub vertical_align: VerticalAlign,
    #[serde(default)]
    pub uppercase: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ClockMode {
    /// Time of day.
    #[default]
    Time,
    /// Remaining time until `target` (time of day or date-time).
    Countdown,
    /// Time since the graphic was taken on air.
    Elapsed,
    /// Counts down from the `target` duration once on air.
    Timer,
}

fn default_font() -> String {
    "Inter".into()
}
fn default_clock_format() -> String {
    "HH:mm:ss".into()
}
fn default_separator() -> String {
    "   •   ".into()
}
fn default_ticker_speed() -> f64 {
    180.0
}
fn default_roll_speed() -> f64 {
    60.0
}

fn default_weight() -> u16 {
    400
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ImageFit {
    #[default]
    Contain,
    Cover,
    Stretch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(flatten)]
    pub kind: LayerKind,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
    /// Static (base) values; a property with keyframes ignores its base value.
    #[serde(default)]
    pub props: BTreeMap<Prop, Value>,
    #[serde(default)]
    pub tracks: BTreeMap<Prop, Vec<Keyframe>>,
    /// Bind a property (colour or number) to a data field key.
    #[serde(default)]
    pub bindings: BTreeMap<Prop, String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerKind {
    /// Playback stops here; "Continue" resumes (MXMZ-style stop point).
    Pause,
    /// Start of the out animation; "Take out" jumps here.
    Out,
    /// Simple label, no playback effect.
    Label,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub frame: f64,
    pub name: String,
    pub kind: MarkerKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    Text,
    Multiline,
    Number,
    Color,
    Image,
}

/// A data input exposed to the operator (Singular "control node" / Flowics input).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: FieldKind,
    #[serde(default)]
    pub default: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    /// Total timeline length in frames.
    pub duration: f64,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub fields: Vec<Field>,
    /// Layers in paint order (first = bottom).
    #[serde(default)]
    pub layers: Vec<Layer>,
    /// Zone the template plays in by default (see [`Zone`]).
    #[serde(default)]
    pub zone: String,
}

impl Template {
    /// First on-air frame: first pause, else the out marker, else the end.
    pub fn hold_frame(&self) -> f64 {
        self.next_pause_after(0.0)
            .or(self.out_frame())
            .unwrap_or(self.duration)
    }

    pub fn layer(&self, id: &str) -> Option<&Layer> {
        self.layers.iter().find(|l| l.id == id)
    }

    pub fn out_frame(&self) -> Option<f64> {
        self.markers
            .iter()
            .find(|m| m.kind == MarkerKind::Out)
            .map(|m| m.frame)
    }

    /// The first pause marker strictly after `frame` (and before the out marker).
    pub fn next_pause_after(&self, frame: f64) -> Option<f64> {
        let limit = self.out_frame().unwrap_or(self.duration);
        self.markers
            .iter()
            .filter(|m| m.kind == MarkerKind::Pause && m.frame > frame + 1e-6 && m.frame <= limit)
            .map(|m| m.frame)
            .fold(None, |acc: Option<f64>, f| {
                Some(acc.map_or(f, |a| a.min(f)))
            })
    }

    /// Default data built from field defaults.
    pub fn default_data(&self) -> BTreeMap<String, String> {
        self.fields
            .iter()
            .map(|f| (f.key.clone(), f.default.clone()))
            .collect()
    }
}

/// An entry of the operator rundown (playlist).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RundownItem {
    pub id: String,
    pub name: String,
    pub template_id: String,
    /// Zone the item plays in ("" = the template's zone).
    #[serde(default)]
    pub zone: String,
    /// Playlist (rundown section) the item belongs to.
    #[serde(default)]
    pub playlist: String,
    /// Playout layer of pre-zone projects; replaced by `zone` on load.
    #[serde(default)]
    pub layer: u32,
    #[serde(default)]
    pub data: BTreeMap<String, String>,
}

/// A named list of rundown items (show segment, sport block, breaking news…).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
}

/// What happens when a graphic is taken in a zone that is already on air.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ZoneTransition {
    /// The graphic on air plays its out animation, then the new one comes in.
    #[default]
    Sequential,
    /// The new graphic replaces the old one immediately.
    Cut,
}

/// An area of the screen that shows one template at a time (lower third,
/// bug, ticker, full screen…). Zones are on air independently of each other.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub id: String,
    pub name: String,
    /// Playout layer, also the stacking order: higher is in front.
    pub layer: u32,
    #[serde(default = "default_zone_color")]
    pub color: String,
    #[serde(default)]
    pub transition: ZoneTransition,
}

impl Zone {
    /// Starting layout of a new project.
    pub fn defaults() -> Vec<Zone> {
        [
            ("lower-third", "Lower third", 10),
            ("top-left", "Top left", 20),
            ("top-right", "Top right", 30),
            ("ticker", "Ticker", 40),
            ("full-screen", "Full screen", 50),
        ]
        .iter()
        .enumerate()
        .map(|(i, (id, name, layer))| Zone {
            id: (*id).into(),
            name: (*name).into(),
            layer: *layer,
            color: ZONE_COLORS[i].into(),
            transition: ZoneTransition::Sequential,
        })
        .collect()
    }
}

fn default_zone_color() -> String {
    "#7c5cff".into()
}

const ZONE_COLORS: [&str; 8] = [
    "#7c5cff", "#ff3b5c", "#22c55e", "#f5a524", "#38bdf8", "#e879f9", "#14b8a6", "#f97316",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// A show project: the templates and the rundown of one programme,
/// designed for one video format (channels scale it to their own format).
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
    #[serde(default)]
    pub templates: Vec<Template>,
    #[serde(default)]
    pub rundown: Vec<RundownItem>,
    /// Screen zones, one graphic on air at a time in each.
    #[serde(default)]
    pub zones: Vec<Zone>,
    /// Sections of the rundown, in display order.
    #[serde(default)]
    pub playlists: Vec<Playlist>,
}

impl Project {
    pub fn zone(&self, id: &str) -> Option<&Zone> {
        self.zones.iter().find(|z| z.id == id)
    }

    pub fn zone_at(&self, layer: u32) -> Option<&Zone> {
        self.zones.iter().find(|z| z.layer == layer)
    }

    /// Zone of a rundown item: its own, else its template's.
    pub fn item_zone(&self, item: &RundownItem) -> Option<&Zone> {
        self.zone(&item.zone).or_else(|| {
            self.template(&item.template_id)
                .and_then(|t| self.zone(&t.zone))
        })
    }

    /// Gives every rundown item and template a zone. Pre-zone projects get
    /// one zone per playout layer they used. Returns true if anything changed.
    pub fn ensure_zones(&mut self) -> bool {
        let mut changed = false;
        for i in 0..self.rundown.len() {
            if self.zone(&self.rundown[i].zone).is_some() {
                continue;
            }
            let layer = self.rundown[i].layer;
            let id = match self.zone_at(layer) {
                Some(z) => z.id.clone(),
                None => {
                    let z = Zone {
                        id: format!("layer-{layer}"),
                        name: format!("Layer {layer}"),
                        layer,
                        color: ZONE_COLORS[self.zones.len() % ZONE_COLORS.len()].into(),
                        transition: ZoneTransition::Sequential,
                    };
                    let id = z.id.clone();
                    self.zones.push(z);
                    id
                }
            };
            self.rundown[i].zone = id;
            changed = true;
        }
        if self.zones.is_empty() {
            self.zones.push(Zone {
                id: "main".into(),
                name: "Main".into(),
                layer: 10,
                color: ZONE_COLORS[0].into(),
                transition: ZoneTransition::Sequential,
            });
            changed = true;
        }
        for t in 0..self.templates.len() {
            if self.zone(&self.templates[t].zone).is_some() {
                continue;
            }
            let tid = self.templates[t].id.clone();
            let zone = self
                .rundown
                .iter()
                .find(|r| r.template_id == tid)
                .map(|r| r.zone.clone())
                .unwrap_or_else(|| self.zones[0].id.clone());
            self.templates[t].zone = zone;
            changed = true;
        }
        // Keep the legacy layer number in step for older clients.
        for i in 0..self.rundown.len() {
            if let Some(l) = self.zone(&self.rundown[i].zone).map(|z| z.layer) {
                if self.rundown[i].layer != l {
                    self.rundown[i].layer = l;
                    changed = true;
                }
            }
        }
        self.zones.sort_by_key(|z| z.layer);
        changed | self.ensure_playlists()
    }

    /// At least one playlist, and every rundown item in an existing one.
    pub fn ensure_playlists(&mut self) -> bool {
        let mut changed = false;
        if self.playlists.is_empty() {
            self.playlists.push(Playlist {
                id: "main".into(),
                name: "Main".into(),
            });
            changed = true;
        }
        let first = self.playlists[0].id.clone();
        for r in &mut self.rundown {
            if !self.playlists.iter().any(|p| p.id == r.playlist) {
                r.playlist = first.clone();
                changed = true;
            }
        }
        changed
    }

    pub fn validate_zones(zones: &[Zone]) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        let mut layers = std::collections::HashSet::new();
        for z in zones {
            let valid = !z.id.is_empty()
                && z.id.len() <= 64
                && z.id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            if !valid || !ids.insert(z.id.as_str()) {
                return Err(format!(
                    "zone ids must be unique and use letters, digits, - or _ (`{}`)",
                    z.id
                ));
            }
            if z.name.trim().is_empty() {
                return Err("every zone needs a name".into());
            }
            if !layers.insert(z.layer) {
                return Err(format!("two zones share the stacking position {}", z.layer));
            }
        }
        if zones.is_empty() {
            return Err("a project needs at least one zone".into());
        }
        Ok(())
    }

    pub fn template(&self, id: &str) -> Option<&Template> {
        self.templates.iter().find(|t| t.id == id)
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}
