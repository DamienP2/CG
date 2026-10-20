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
        match raw.trim() {
            "true" => Some(Value::Number(1.0)),
            "false" => Some(Value::Number(0.0)),
            t => t.parse::<f64>().ok().map(Value::Number),
        }
    }
}

/// Resolves a layer at `frame`. `hold` is the template's on-air frame: a
/// data value bound to an animated number sets the value seen on air and the
/// animation moves relative to it (an operator changes where a lower third
/// sits, its slide-in still works). Colours and static values are replaced.
pub fn resolve_layer<'a>(
    layer: &'a Layer,
    frame: f64,
    data: &Data,
    hold: f64,
) -> ResolvedLayer<'a> {
    let values = Prop::ALL
        .iter()
        .map(|&p| {
            let bound = layer
                .bindings
                .get(&p)
                .and_then(|key| data.get(key))
                .and_then(|raw| binding_value(p, raw));
            let track = layer.tracks.get(&p).filter(|t| !t.is_empty());
            let animated = track.and_then(|t| sample_track(t, frame));
            let v = match (bound, animated) {
                (Some(Value::Number(b)), Some(Value::Number(a))) => {
                    let at_hold = track
                        .and_then(|t| sample_track(t, hold))
                        .and_then(|v| v.as_number())
                        .unwrap_or(a);
                    Value::Number(a + b - at_hold)
                }
                (Some(b), _) => b,
                (None, Some(a)) => a,
                (None, None) => layer
                    .props
                    .get(&p)
                    .copied()
                    .unwrap_or_else(|| default_value(p)),
            };
            (p, v)
        })
        .collect();
    let (text, image_src) = match &layer.kind {
        LayerKind::Text {
            text,
            uppercase,
            transform,
            ..
        } => {
            let case = |t: &str| {
                if *uppercase {
                    t.to_uppercase()
                } else {
                    transform.apply(t)
                }
            };
            // Styled parts (<b>…): the text without its tags.
            let shown = match crate::rich::runs(text, data, |_| false, case) {
                Some(runs) => runs.into_iter().map(|r| r.text).collect(),
                None => case(&interpolate_text(text, data)),
            };
            (Some(shown), None)
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
        .map(|l| resolve_layer(l, frame, data, template.hold_frame()))
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
    fn bound_animated_number_is_an_offset() {
        let mut layer: Layer =
            serde_json::from_str(r#"{"id":"a","name":"a","type":"rect"}"#).unwrap();
        // Slides in from x=-500 to x=100 by the hold frame 20.
        layer.tracks.insert(
            Prop::X,
            vec![
                kf(0.0, -500.0, Easing::Linear),
                kf(20.0, 100.0, Easing::Linear),
            ],
        );
        layer.bindings.insert(Prop::X, "x".into());
        let mut d = Data::new();
        d.insert("x".into(), "300".into());
        let x = |f: f64| resolve_layer(&layer, f, &d, 20.0).num(Prop::X);
        assert_eq!(x(20.0), 300.0);
        assert_eq!(x(0.0), -300.0);
        // Without the field the animation is unchanged.
        assert_eq!(
            resolve_layer(&layer, 0.0, &Data::new(), 20.0).num(Prop::X),
            -500.0
        );
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
