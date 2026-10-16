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
}

impl Template {
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
    /// Playout layer: graphics on different layers can be on air together.
    #[serde(default)]
    pub layer: u32,
    #[serde(default)]
    pub data: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
    #[serde(default)]
    pub templates: Vec<Template>,
    #[serde(default)]
    pub rundown: Vec<RundownItem>,
}

impl Project {
    pub fn template(&self, id: &str) -> Option<&Template> {
        self.templates.iter().find(|t| t.id == id)
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}
