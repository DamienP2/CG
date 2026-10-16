//! Demo project used when the server starts without data.

use std::collections::BTreeMap;

use crate::easing::Easing;
use crate::model::*;

fn kf(frame: f64, v: f64, easing: Easing) -> Keyframe {
    Keyframe {
        frame,
        value: Value::Number(v),
        easing,
    }
}

fn hex(s: &str) -> Value {
    Value::Color(Color::from_hex(s).expect("valid hex"))
}

fn layer(
    id: &str,
    name: &str,
    kind: LayerKind,
    parent: Option<&str>,
    props: &[(Prop, Value)],
) -> Layer {
    Layer {
        id: id.into(),
        name: name.into(),
        parent: parent.map(Into::into),
        kind,
        visible: true,
        locked: false,
        props: props.iter().copied().collect(),
        tracks: BTreeMap::new(),
        bindings: BTreeMap::new(),
    }
}

fn text(t: &str, weight: u16) -> LayerKind {
    LayerKind::Text {
        text: t.into(),
        font_family: "Inter".into(),
        font_weight: weight,
        align: TextAlign::Left,
        vertical_align: VerticalAlign::Middle,
        uppercase: false,
    }
}

fn marker(frame: f64, name: &str, kind: MarkerKind) -> Marker {
    Marker {
        id: new_id(),
        frame,
        name: name.into(),
        kind,
    }
}

pub fn lower_third() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut group = layer(
        "lt-group",
        "Lower third",
        LayerKind::Group { clip: true },
        None,
        &[
            (X, n(160.0)),
            (Y, n(820.0)),
            (Width, n(1100.0)),
            (Height, n(150.0)),
        ],
    );
    group.tracks.insert(
        CropRight,
        vec![
            kf(0.0, 1.0, Easing::EaseOut),
            kf(18.0, 0.0, Easing::Linear),
            kf(100.0, 0.0, Easing::EaseIn),
            kf(115.0, 1.0, Easing::Linear),
        ],
    );

    let mut accent = layer(
        "lt-accent",
        "Accent bar",
        LayerKind::Rect,
        Some("lt-group"),
        &[
            (X, n(0.0)),
            (Y, n(0.0)),
            (Width, n(14.0)),
            (Height, n(150.0)),
            (Fill, hex("#ff3b5c")),
        ],
    );
    accent.tracks.insert(
        Height,
        vec![kf(0.0, 0.0, Easing::Back), kf(14.0, 150.0, Easing::Linear)],
    );

    let plate = layer(
        "lt-plate",
        "Plate",
        LayerKind::Rect,
        Some("lt-group"),
        &[
            (X, n(14.0)),
            (Y, n(0.0)),
            (Width, n(1086.0)),
            (Height, n(95.0)),
            (Fill, hex("#0f1222e6")),
        ],
    );
    let mut sub = layer(
        "lt-sub",
        "Subtitle plate",
        LayerKind::Rect,
        Some("lt-group"),
        &[
            (X, n(14.0)),
            (Y, n(95.0)),
            (Width, n(700.0)),
            (Height, n(55.0)),
            (Fill, hex("#ff3b5c")),
        ],
    );
    sub.tracks.insert(
        Width,
        vec![
            kf(8.0, 0.0, Easing::EaseOut),
            kf(26.0, 700.0, Easing::Linear),
        ],
    );

    let mut name = layer(
        "lt-name",
        "Name",
        text("{{name}}", 700),
        Some("lt-group"),
        &[
            (X, n(48.0)),
            (Y, n(0.0)),
            (Width, n(1040.0)),
            (Height, n(95.0)),
            (FontSize, n(56.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    name.tracks.insert(
        Opacity,
        vec![kf(10.0, 0.0, Easing::Linear), kf(22.0, 1.0, Easing::Linear)],
    );
    name.tracks.insert(
        X,
        vec![
            kf(10.0, 18.0, Easing::EaseOut),
            kf(24.0, 48.0, Easing::Linear),
        ],
    );

    let mut title = layer(
        "lt-title",
        "Title",
        text("{{title}}", 500),
        Some("lt-group"),
        &[
            (X, n(48.0)),
            (Y, n(95.0)),
            (Width, n(660.0)),
            (Height, n(55.0)),
            (FontSize, n(30.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    if let LayerKind::Text { uppercase, .. } = &mut title.kind {
        *uppercase = true;
    }
    title.tracks.insert(
        Opacity,
        vec![kf(18.0, 0.0, Easing::Linear), kf(30.0, 1.0, Easing::Linear)],
    );

    Template {
        id: "lower-third".into(),
        name: "Lower third".into(),
        duration: 125.0,
        markers: vec![
            marker(40.0, "On air", MarkerKind::Pause),
            marker(100.0, "Out", MarkerKind::Out),
        ],
        fields: vec![
            Field {
                key: "name".into(),
                label: "Name".into(),
                kind: FieldKind::Text,
                default: "Jane Doe".into(),
            },
            Field {
                key: "title".into(),
                label: "Title".into(),
                kind: FieldKind::Text,
                default: "Special correspondent".into(),
            },
        ],
        layers: vec![group, accent, plate, sub, name, title],
    }
}

pub fn score_bug() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut bg = layer(
        "sb-bg",
        "Background",
        LayerKind::Rect,
        None,
        &[
            (X, n(80.0)),
            (Y, n(60.0)),
            (Width, n(420.0)),
            (Height, n(56.0)),
            (Fill, hex("#0f1222f0")),
            (CornerRadius, n(10.0)),
        ],
    );
    bg.tracks.insert(
        Opacity,
        vec![
            kf(0.0, 0.0, Easing::Linear),
            kf(10.0, 1.0, Easing::Linear),
            kf(50.0, 1.0, Easing::Linear),
            kf(60.0, 0.0, Easing::Linear),
        ],
    );
    bg.tracks.insert(
        Y,
        vec![kf(0.0, 30.0, Easing::Back), kf(14.0, 60.0, Easing::Linear)],
    );
    let mk_text = |id: &str, name: &str, t: &str, x: f64, w: f64, align: TextAlign| {
        let mut l = layer(
            id,
            name,
            LayerKind::Text {
                text: t.into(),
                font_family: "Inter".into(),
                font_weight: 700,
                align,
                vertical_align: VerticalAlign::Middle,
                uppercase: true,
            },
            None,
            &[
                (X, n(x)),
                (Y, n(60.0)),
                (Width, n(w)),
                (Height, n(56.0)),
                (FontSize, n(30.0)),
                (Fill, hex("#ffffff")),
            ],
        );
        l.tracks.insert(
            Opacity,
            vec![
                kf(6.0, 0.0, Easing::Linear),
                kf(16.0, 1.0, Easing::Linear),
                kf(50.0, 1.0, Easing::Linear),
                kf(58.0, 0.0, Easing::Linear),
            ],
        );
        l
    };
    let mut score = layer(
        "sb-score-bg",
        "Score plate",
        LayerKind::Rect,
        None,
        &[
            (X, n(230.0)),
            (Y, n(60.0)),
            (Width, n(120.0)),
            (Height, n(56.0)),
            (Fill, hex("#ff3b5c")),
        ],
    );
    score.tracks.insert(
        ScaleX,
        vec![
            kf(4.0, 0.0, Easing::Back),
            kf(16.0, 1.0, Easing::Linear),
            kf(50.0, 1.0, Easing::EaseIn),
            kf(58.0, 0.0, Easing::Linear),
        ],
    );
    score.props.insert(AnchorX, n(0.5));
    Template {
        id: "score-bug".into(),
        name: "Score bug".into(),
        duration: 60.0,
        markers: vec![
            marker(20.0, "On air", MarkerKind::Pause),
            marker(50.0, "Out", MarkerKind::Out),
        ],
        fields: vec![
            Field {
                key: "home".into(),
                label: "Home".into(),
                kind: FieldKind::Text,
                default: "PSG".into(),
            },
            Field {
                key: "away".into(),
                label: "Away".into(),
                kind: FieldKind::Text,
                default: "OM".into(),
            },
            Field {
                key: "homeScore".into(),
                label: "Home score".into(),
                kind: FieldKind::Number,
                default: "0".into(),
            },
            Field {
                key: "awayScore".into(),
                label: "Away score".into(),
                kind: FieldKind::Number,
                default: "0".into(),
            },
        ],
        layers: vec![
            bg,
            score,
            mk_text("sb-home", "Home", "{{home}}", 100.0, 120.0, TextAlign::Left),
            mk_text(
                "sb-score",
                "Score",
                "{{homeScore}} - {{awayScore}}",
                230.0,
                120.0,
                TextAlign::Center,
            ),
            mk_text(
                "sb-away",
                "Away",
                "{{away}}",
                360.0,
                120.0,
                TextAlign::Right,
            ),
        ],
    }
}

pub fn demo_project() -> Project {
    let mut data = BTreeMap::new();
    data.insert("name".to_string(), "Marie Curie".to_string());
    data.insert("title".to_string(), "Physicist & chemist".to_string());
    Project {
        id: "demo".into(),
        name: "Demo show".into(),
        width: 1920,
        height: 1080,
        frame_rate: FrameRate::new(50, 1),
        templates: vec![lower_third(), score_bug()],
        rundown: vec![
            RundownItem {
                id: new_id(),
                name: "LT – Marie Curie".into(),
                template_id: "lower-third".into(),
                layer: 10,
                data,
            },
            RundownItem {
                id: new_id(),
                name: "Score PSG – OM".into(),
                template_id: "score-bug".into(),
                layer: 20,
                data: [("homeScore", "2"), ("awayScore", "1")]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn demo_roundtrips_through_json() {
        let p = super::demo_project();
        let json = serde_json::to_string(&p).unwrap();
        let back: crate::Project = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }
}
