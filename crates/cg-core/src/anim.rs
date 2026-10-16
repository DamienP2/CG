//! Evaluates templates at a given frame: keyframe interpolation, data
//! bindings and defaults. Output is a flat list of fully resolved layers that a
//! renderer can paint without knowing anything about animation.

use std::collections::BTreeMap;

use crate::model::{Color, Keyframe, Layer, LayerKind, Prop, Template, Value};

/// Default value of each property when neither set nor animated.
pub fn default_value(prop: Prop) -> Value {
    use Prop::*;
    match prop {
        X | Y | Rotation | StrokeWidth | CornerRadius | LetterSpacing => Value::Number(0.0),
        // Rotation / scale pivot at the centre of the box, like After Effects.
        AnchorX | AnchorY => Value::Number(0.5),
        CropLeft | CropRight | CropTop | CropBottom => Value::Number(0.0),
        Width => Value::Number(400.0),
        Height => Value::Number(100.0),
        ScaleX | ScaleY | Opacity => Value::Number(1.0),
        FontSize => Value::Number(48.0),
        Fill => Value::Color(Color::WHITE),
        Stroke => Value::Color(Color::TRANSPARENT),
    }
}

fn lerp_value(a: Value, b: Value, t: f64) -> Value {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => Value::Number(a + (b - a) * t),
        (Value::Color(Color(a)), Value::Color(Color(b))) => {
            let t = t as f32;
            Value::Color(Color(std::array::from_fn(|i| a[i] + (b[i] - a[i]) * t)))
        }
        // Mismatched types: snap at the end of the segment.
        (a, b) => {
            if t < 1.0 {
                a
            } else {
                b
            }
        }
    }
}

/// Samples a keyframe track. Keyframes are expected sorted by frame, but we
/// don't rely on it for correctness.
pub fn sample_track(track: &[Keyframe], frame: f64) -> Option<Value> {
    if track.is_empty() {
        return None;
    }
    let mut sorted: Vec<&Keyframe> = track.iter().collect();
    sorted.sort_by(|a, b| a.frame.total_cmp(&b.frame));
    let first = sorted[0];
    if frame <= first.frame {
        return Some(first.value);
    }
    for pair in sorted.windows(2) {
        let (k0, k1) = (pair[0], pair[1]);
        if frame >= k0.frame && frame < k1.frame {
            let span = (k1.frame - k0.frame).max(1e-9);
            let t = k0.easing.apply((frame - k0.frame) / span);
            return Some(lerp_value(k0.value, k1.value, t));
        }
    }
    Some(sorted[sorted.len() - 1].value)
}

/// Data values keyed by field key.
pub type Data = BTreeMap<String, String>;

/// Replaces `{{key}}` placeholders by data values (unknown keys → empty).
pub fn interpolate_text(text: &str, data: &Data) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let key = after[..end].trim();
                if let Some(v) = data.get(key) {
                    out.push_str(v);
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// A layer with every property resolved for one frame.
#[derive(Debug, Clone)]
pub struct ResolvedLayer<'a> {
    pub layer: &'a Layer,
    pub values: BTreeMap<Prop, Value>,
    /// Text content after data substitution (text layers).
    pub text: Option<String>,
    /// Image source after data substitution (image layers).
    pub image_src: Option<String>,
}

impl ResolvedLayer<'_> {
    pub fn num(&self, p: Prop) -> f64 {
        self.values
            .get(&p)
            .and_then(Value::as_number)
            .unwrap_or(0.0)
    }
    pub fn color(&self, p: Prop) -> Color {
        self.values
            .get(&p)
            .and_then(Value::as_color)
            .unwrap_or(Color::TRANSPARENT)
    }
}

fn binding_value(prop: Prop, raw: &str) -> Option<Value> {
    if prop.is_color() {
        Color::from_hex(raw).map(Value::Color)
    } else {
        raw.trim().parse::<f64>().ok().map(Value::Number)
    }
}

pub fn resolve_layer<'a>(layer: &'a Layer, frame: f64, data: &Data) -> ResolvedLayer<'a> {
    let values = Prop::ALL
        .iter()
        .map(|&p| {
            let bound = layer
                .bindings
                .get(&p)
                .and_then(|key| data.get(key))
                .and_then(|raw| binding_value(p, raw));
            let v = bound
                .or_else(|| layer.tracks.get(&p).and_then(|t| sample_track(t, frame)))
                .or_else(|| layer.props.get(&p).copied())
                .unwrap_or_else(|| default_value(p));
            (p, v)
        })
        .collect();
    let (text, image_src) = match &layer.kind {
        LayerKind::Text {
            text, uppercase, ..
        } => {
            let t = interpolate_text(text, data);
            (Some(if *uppercase { t.to_uppercase() } else { t }), None)
        }
        LayerKind::Image { src, .. } => (None, Some(interpolate_text(src, data))),
        _ => (None, None),
    };
    ResolvedLayer {
        layer,
        values,
        text,
        image_src,
    }
}

/// Resolves all visible layers of a template, keeping paint order.
pub fn resolve_template<'a>(
    template: &'a Template,
    frame: f64,
    data: &Data,
) -> Vec<ResolvedLayer<'a>> {
    template
        .layers
        .iter()
        .filter(|l| l.visible)
        .map(|l| resolve_layer(l, frame, data))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::easing::Easing;

    fn kf(frame: f64, v: f64, easing: Easing) -> Keyframe {
        Keyframe {
            frame,
            value: Value::Number(v),
            easing,
        }
    }

    #[test]
    fn linear_interpolation() {
        let track = vec![
            kf(0.0, 0.0, Easing::Linear),
            kf(10.0, 100.0, Easing::Linear),
        ];
        assert_eq!(sample_track(&track, -5.0), Some(Value::Number(0.0)));
        assert_eq!(sample_track(&track, 5.0), Some(Value::Number(50.0)));
        assert_eq!(sample_track(&track, 20.0), Some(Value::Number(100.0)));
    }

    #[test]
    fn hold_interpolation() {
        let track = vec![kf(0.0, 1.0, Easing::Hold), kf(10.0, 2.0, Easing::Linear)];
        assert_eq!(sample_track(&track, 9.9), Some(Value::Number(1.0)));
        assert_eq!(sample_track(&track, 10.0), Some(Value::Number(2.0)));
    }

    #[test]
    fn text_placeholders() {
        let mut d = Data::new();
        d.insert("name".into(), "Jane Doe".into());
        assert_eq!(interpolate_text("Hello {{ name }}!", &d), "Hello Jane Doe!");
        assert_eq!(interpolate_text("{{missing}}x", &d), "x");
        assert_eq!(interpolate_text("open {{ brace", &d), "open {{ brace");
    }
}
