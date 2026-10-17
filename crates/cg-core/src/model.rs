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
pub enum TextTransform {
    #[default]
    None,
    Upper,
    Lower,
    /// First letter of each word.
    Capitalize,
}

impl TextTransform {
    pub fn is_none(&self) -> bool {
        *self == TextTransform::None
    }

    pub fn apply(&self, t: &str) -> String {
        match self {
            TextTransform::None => t.to_string(),
            TextTransform::Upper => t.to_uppercase(),
            TextTransform::Lower => t.to_lowercase(),
            TextTransform::Capitalize => crate::datapath::filter(t, &DataFilter::Capitalize),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextDecoration {
    #[default]
    None,
    Underline,
    LineThrough,
}

impl TextDecoration {
    pub fn is_none(&self) -> bool {
        *self == TextDecoration::None
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
        /// Paragraph: lines wrap at the box width.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        wrap: bool,
        /// Case change (`uppercase` = true still means upper case).
        #[serde(default, skip_serializing_if = "TextTransform::is_none")]
        transform: TextTransform,
        #[serde(default, skip_serializing_if = "TextDecoration::is_none")]
        decoration: TextDecoration,
        /// Line height, in font sizes (default 1.2).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line_height: Option<f32>,
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
    /// Timed widgets (timer, ticker…) wait for the operator to start them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual_start: bool,
    /// Scale X and Y change together (designer setting).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub scale_lock: bool,
    /// Static (base) values; a property with keyframes ignores its base value.
    #[serde(default)]
    pub props: BTreeMap<Prop, Value>,
    #[serde(default)]
    pub tracks: BTreeMap<Prop, Vec<Keyframe>>,
    /// Bind a property (colour or number) to a data field key.
    #[serde(default)]
    pub bindings: BTreeMap<Prop, String>,
    /// Changes in the project's other formats (9:16, 1:1…), by format id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub overrides: BTreeMap<String, LayerOverride>,
}

/// How a layer differs in one format: its own static values, animations
/// and visibility; anything not listed is inherited from the main format.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerOverride {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub props: BTreeMap<Prop, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tracks: BTreeMap<Prop, Vec<Keyframe>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
}

/// An alternative layout of a project, e.g. 9:16 for social media. The
/// main format is the project's own width × height (id "main").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

pub const MAIN_FORMAT: &str = "main";

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerKind {
    /// Playback stops here and resumes as set by [`Marker::resume`]
    /// (operator "Continue", after a delay, or on a trigger). Before the
    /// on-air point they build the graphic in steps; after it, they stop
    /// the out animation.
    Pause,
    /// The on-air point, which is also where the out animation starts: the
    /// take holds here, "Take out" plays on from here. One per template.
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
    /// How a pause resumes.
    #[serde(default, skip_serializing_if = "Resume::is_manual")]
    pub resume: Resume,
}

/// How playback resumes from a pause marker.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Resume {
    /// The operator presses Continue.
    #[default]
    Manual,
    /// By itself after a delay.
    After { seconds: f64 },
    /// When this trigger is fired (by the operator, the API, Companion…).
    Trigger { name: String },
}

impl Resume {
    pub fn is_manual(&self) -> bool {
        matches!(self, Resume::Manual)
    }
}

/// Current marker model: [`MarkerKind::Out`] is the on-air point.
pub const MARKER_MODEL: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    Text,
    Multiline,
    Number,
    Color,
    Image,
    /// On / off ("true" / "false"; 1 / 0 for a number property).
    Boolean,
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
    /// Live value from a data source (see [`crate::datapath`]); it
    /// replaces what the operator types while the source has a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<FieldBinding>,
    /// Range of a number (slider in the editors).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

/// Where a field takes its value: a data source and a path in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldBinding {
    pub source: String,
    /// `items[0].title`, `rows[{row}].name`, `players[number={num}].name`,
    /// `items[*].title` (all, one per line), `items.length`.
    pub path: String,
    /// Applied in order to the value read (see [`crate::datapath::filter`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<DataFilter>,
}

/// A step between a data source and a field: changes the text read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DataFilter {
    Upper,
    Lower,
    /// First letter of each word in capitals.
    Capitalize,
    Trim,
    Prefix {
        text: String,
    },
    Suffix {
        text: String,
    },
    Replace {
        find: String,
        with: String,
    },
    /// At most `max` characters, then "…".
    Truncate {
        max: usize,
    },
    /// Lines `from` (1 = first, negative = from the end), `count` of them (0 = all).
    Lines {
        from: i64,
        count: usize,
    },
    /// The lines joined with `separator` (a list on one line).
    Join {
        separator: String,
    },
    /// A number with `decimals` and thousands grouping.
    Number {
        decimals: u8,
        grouping: bool,
    },
    /// A number: value `op` operand.
    Math {
        op: FilterOp,
        value: f64,
    },
    /// `text` when the value is empty (or missing).
    Default {
        text: String,
    },
    /// `then` when the value equals `when`, else unchanged.
    Map {
        when: String,
        then: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Add,
    Sub,
    Mul,
    Div,
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
    /// Relations between values (node graph), see [`crate::logic`].
    #[serde(default, skip_serializing_if = "crate::logic::Logic::is_empty")]
    pub logic: crate::logic::Logic,
    /// Published revision (1, 2…); 0 for a template never published.
    #[serde(default)]
    pub revision: u32,
    /// Marker model the template was made with ([`MARKER_MODEL`]); older
    /// templates are converted by [`Template::normalize_markers`].
    #[serde(default)]
    pub marker_model: u8,
}

impl Template {
    /// An empty template: 2 s at 50 fps, on air at 1 s.
    pub fn blank(name: &str, zone: &str) -> Self {
        Template {
            id: new_id(),
            name: name.into(),
            duration: 100.0,
            markers: vec![Marker {
                id: new_id(),
                frame: 50.0,
                name: "On air".into(),
                kind: MarkerKind::Out,
                resume: Resume::Manual,
            }],
            fields: Vec::new(),
            layers: Vec::new(),
            zone: zone.into(),
            logic: Default::default(),
            revision: 0,
            marker_model: MARKER_MODEL,
        }
    }

    /// The template as laid out in `format` (overrides applied); the main
    /// format, or a format without overrides, borrows it unchanged.
    pub fn in_format(&self, format: &str) -> std::borrow::Cow<'_, Template> {
        if format == MAIN_FORMAT || !self.layers.iter().any(|l| l.overrides.contains_key(format)) {
            return std::borrow::Cow::Borrowed(self);
        }
        let mut t = self.clone();
        for l in &mut t.layers {
            if let Some(o) = l.overrides.get(format) {
                for (p, v) in &o.props {
                    l.props.insert(*p, *v);
                    l.tracks.remove(p);
                }
                for (p, k) in &o.tracks {
                    l.tracks.insert(*p, k.clone());
                }
                if let Some(v) = o.visible {
                    l.visible = v;
                }
            }
        }
        std::borrow::Cow::Owned(t)
    }

    /// The on-air frame (what the graphic looks like on air): the on-air /
    /// out marker, else the end.
    pub fn hold_frame(&self) -> f64 {
        self.out_frame().unwrap_or(self.duration)
    }

    /// Where playback stops next after `frame`: the next pause or the
    /// on-air point, else the end.
    pub fn next_stop_after(&self, frame: f64) -> f64 {
        let on_air = self.out_frame().filter(|&o| o > frame + 1e-6);
        self.markers
            .iter()
            .filter(|m| m.kind == MarkerKind::Pause && m.frame > frame + 1e-6)
            .map(|m| m.frame)
            .chain(on_air)
            .fold(self.duration, f64::min)
    }

    /// The pause marker at `frame`, if any.
    pub fn pause_at(&self, frame: f64) -> Option<&Marker> {
        self.markers
            .iter()
            .find(|m| m.kind == MarkerKind::Pause && (m.frame - frame).abs() < 1e-6)
    }

    /// Brings the markers to the current model: one on-air / out marker,
    /// frames inside the timeline. Templates made when the on-air point was
    /// the first pause (and the out marker could come later) get their last
    /// stop as the on-air point, and the never-played frames between it and
    /// the old out marker are cut. Returns true if anything changed.
    pub fn normalize_markers(&mut self) -> bool {
        let before = (self.markers.clone(), self.duration, self.marker_model);
        if self.marker_model < MARKER_MODEL {
            self.marker_model = MARKER_MODEL;
            if let Some(out) = self.out_frame() {
                let last_stop = self
                    .markers
                    .iter()
                    .filter(|m| m.kind == MarkerKind::Pause && m.frame <= out + 1e-6)
                    .map(|m| m.frame)
                    .fold(None, |a: Option<f64>, f| Some(a.map_or(f, |a| a.max(f))));
                if let Some(stop) = last_stop {
                    self.markers.retain(|m| {
                        !(m.kind == MarkerKind::Pause && (m.frame - stop).abs() < 1e-6)
                    });
                    if out > stop + 1e-6 {
                        self.cut(stop, out);
                    }
                }
            }
            for m in &mut self.markers {
                if m.kind == MarkerKind::Pause && m.name.eq_ignore_ascii_case("on air") {
                    m.name = "Pause".into();
                }
            }
        }
        // Exactly one on-air / out marker.
        let mut seen = false;
        self.markers.retain(|m| {
            let dup = m.kind == MarkerKind::Out && seen;
            seen |= m.kind == MarkerKind::Out;
            !dup
        });
        if !seen {
            self.markers.push(Marker {
                id: crate::model::new_id(),
                frame: self.duration,
                name: "On air".into(),
                kind: MarkerKind::Out,
                resume: Resume::Manual,
            });
        }
        for m in &mut self.markers {
            m.frame = m.frame.clamp(0.0, self.duration);
            if m.kind == MarkerKind::Out {
                m.name = "On air".into();
                m.resume = Resume::Manual;
            }
        }
        self.markers.sort_by(|a, b| a.frame.total_cmp(&b.frame));
        before != (self.markers.clone(), self.duration, self.marker_model)
    }

    /// Removes the frames between `from` and `to`: later keyframes and
    /// markers move back, keyframes inside are dropped.
    fn cut(&mut self, from: f64, to: f64) {
        let d = to - from;
        let shift = |keys: &mut Vec<Keyframe>| {
            keys.retain(|k| k.frame <= from + 1e-6 || k.frame >= to - 1e-6);
            for k in keys.iter_mut() {
                if k.frame >= to - 1e-6 {
                    k.frame -= d;
                }
            }
            keys.dedup_by(|b, a| (a.frame - b.frame).abs() < 1e-6);
        };
        for l in &mut self.layers {
            l.tracks.values_mut().for_each(shift);
            for o in l.overrides.values_mut() {
                o.tracks.values_mut().for_each(shift);
            }
        }
        for m in &mut self.markers {
            if m.frame >= to - 1e-6 {
                m.frame -= d;
            } else if m.frame > from {
                m.frame = from;
            }
        }
        self.duration = (self.duration - d).max(1.0);
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
    /// When the fields bound to data sources are read.
    #[serde(default, skip_serializing_if = "ReadMode::is_live")]
    pub read: ReadMode,
}

/// When a rundown item reads its data sources.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadMode {
    /// On take, then on every change of the source, also on air.
    #[default]
    Live,
    /// Once, when the item is taken.
    Take,
    /// Only when the operator asks (the values are saved in the item).
    Manual,
}

impl ReadMode {
    pub fn is_live(&self) -> bool {
        *self == ReadMode::Live
    }
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
    /// Where the zone sits, by format id (fractions of the frame), shown as
    /// a guide in the designer. A format without its own area uses the main
    /// one, else a default derived from the zone id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub areas: BTreeMap<String, Area>,
}

/// A rectangle in fractions of the frame (0..1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Area {
    pub const FULL: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    };

    /// Covers the whole frame (nothing to cut).
    pub fn is_full(&self) -> bool {
        self.x <= 1e-6
            && self.y <= 1e-6
            && self.x + self.width >= 1.0 - 1e-6
            && self.y + self.height >= 1.0 - 1e-6
    }
}

impl Zone {
    /// Where the zone sits in a format: its own area, the main one, or a
    /// default (mirrors `web/src/engine/zones.ts`).
    pub fn area(&self, format: &str, portrait: bool) -> Area {
        if let Some(a) = self
            .areas
            .get(format)
            .or_else(|| self.areas.get(MAIN_FORMAT))
        {
            return *a;
        }
        let a = |x, y, width, height| Area {
            x,
            y,
            width,
            height,
        };
        let (land, port) = match self.id.as_str() {
            "lower-third" => (a(0.06, 0.7, 0.6, 0.19), a(0.05, 0.66, 0.9, 0.16)),
            "top-left" => (a(0.04, 0.05, 0.24, 0.14), a(0.05, 0.04, 0.42, 0.08)),
            "top-right" => (a(0.72, 0.05, 0.24, 0.14), a(0.53, 0.04, 0.42, 0.08)),
            "ticker" => (a(0.0, 0.89, 1.0, 0.07), a(0.0, 0.9, 1.0, 0.05)),
            "full-screen" => (Area::FULL, Area::FULL),
            _ => (a(0.25, 0.25, 0.5, 0.5), a(0.1, 0.3, 0.8, 0.3)),
        };
        if portrait {
            port
        } else {
            land
        }
    }

    /// Starting layout of a new project: one full-screen zone.
    pub fn defaults() -> Vec<Zone> {
        [("full-screen", "Full screen", 10)]
            .iter()
            .enumerate()
            .map(|(i, (id, name, layer))| Zone {
                id: (*id).into(),
                name: (*name).into(),
                layer: *layer,
                color: ZONE_COLORS[i].into(),
                transition: ZoneTransition::Sequential,
                areas: Default::default(),
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
    /// Alternative layouts (the main one is width × height).
    #[serde(default)]
    pub formats: Vec<Format>,
    /// Designer working copies not yet published. `templates` is what the
    /// operator, the outputs and automation use; "Publish" moves a draft
    /// there. A draft without a published template is a new template.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drafts: Vec<Template>,
}

impl Project {
    /// The project format closest in aspect ratio to a `width` × `height`
    /// output: (format id, design width, design height).
    pub fn format_for(&self, width: u32, height: u32) -> (&str, u32, u32) {
        let target = (width.max(1) as f64 / height.max(1) as f64).ln();
        let main = (MAIN_FORMAT, self.width, self.height);
        std::iter::once(main)
            .chain(
                self.formats
                    .iter()
                    .map(|f| (f.id.as_str(), f.width, f.height)),
            )
            .min_by(|a, b| {
                let d = |f: &(&str, u32, u32)| {
                    ((f.1.max(1) as f64 / f.2.max(1) as f64).ln() - target).abs()
                };
                d(a).total_cmp(&d(b))
            })
            .unwrap_or(main)
    }

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
        // Also brings the templates to the current marker model.
        let mut changed = false;
        for t in self.templates.iter_mut().chain(self.drafts.iter_mut()) {
            changed |= t.normalize_markers();
        }
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
                        areas: Default::default(),
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
                areas: Default::default(),
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

    /// The published template (what goes on air).
    pub fn template(&self, id: &str) -> Option<&Template> {
        self.templates.iter().find(|t| t.id == id)
    }

    /// The template as the designer sees it: its draft, else the published one.
    pub fn draft(&self, id: &str) -> Option<&Template> {
        self.drafts
            .iter()
            .find(|t| t.id == id)
            .or_else(|| self.template(id))
    }

    /// Saves a designer edit as a draft (nothing changes on air).
    pub fn save_draft(&mut self, t: Template) {
        match self.drafts.iter_mut().find(|x| x.id == t.id) {
            Some(d) => *d = t,
            None => self.drafts.push(t),
        }
    }

    /// Publishes a template's draft: the operator and the outputs use it
    /// from now on. Returns the new revision, or None without a draft.
    pub fn publish(&mut self, id: &str) -> Option<u32> {
        let i = self.drafts.iter().position(|t| t.id == id)?;
        let mut t = self.drafts.remove(i);
        let rev = self.template(id).map_or(0, |p| p.revision) + 1;
        t.revision = rev;
        match self.templates.iter_mut().find(|x| x.id == id) {
            Some(p) => *p = t,
            None => self.templates.push(t),
        }
        Some(rev)
    }

    /// Every template the designer lists: published ones (or their draft),
    /// then new drafts.
    pub fn design_templates(&self) -> impl Iterator<Item = &Template> {
        self.templates
            .iter()
            .map(|t| self.draft(&t.id).unwrap_or(t))
            .chain(
                self.drafts
                    .iter()
                    .filter(|d| self.template(&d.id).is_none()),
            )
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_markers_become_one_on_air_marker() {
        // Before: on air at 40 (first pause), out animation from 100.
        let mut t = crate::sample::lower_third();
        assert_eq!(t.marker_model, 0);
        let duration = t.duration;
        let last_key = t
            .layers
            .iter()
            .flat_map(|l| l.tracks.values().flatten())
            .map(|k| k.frame)
            .fold(0.0, f64::max);
        assert!(t.normalize_markers());
        let kinds: Vec<_> = t.markers.iter().map(|m| (m.kind, m.frame)).collect();
        assert_eq!(kinds, vec![(MarkerKind::Out, 40.0)]);
        // The 60 frames never played (40 → 100) are cut.
        assert_eq!(t.duration, duration - 60.0);
        let new_last = t
            .layers
            .iter()
            .flat_map(|l| l.tracks.values().flatten())
            .map(|k| k.frame)
            .fold(0.0, f64::max);
        assert_eq!(new_last, last_key - 60.0);
        assert_eq!(t.hold_frame(), 40.0);
        // Idempotent.
        assert!(!t.normalize_markers());
    }

    #[test]
    fn pauses_before_on_air_keep_their_role() {
        let mut t = crate::sample::lower_third();
        t.marker_model = MARKER_MODEL;
        t.markers.retain(|m| m.kind == MarkerKind::Out);
        t.markers.push(Marker {
            id: "p".into(),
            frame: 10.0,
            name: "Pause".into(),
            kind: MarkerKind::Pause,
            resume: Resume::Manual,
        });
        t.normalize_markers();
        assert_eq!(t.next_stop_after(0.0), 10.0);
        assert_eq!(t.next_stop_after(10.0), 100.0);
        assert_eq!(t.hold_frame(), 100.0);
    }
}
