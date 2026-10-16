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

fn font(weight: u16, align: TextAlign) -> FontStyle {
    FontStyle {
        font_family: "Inter".into(),
        font_weight: weight,
        align,
        vertical_align: VerticalAlign::Middle,
        uppercase: false,
    }
}

fn fade(l: &mut Layer, in_at: f64, out_at: f64) {
    l.tracks.insert(
        Prop::Opacity,
        vec![
            kf(in_at, 0.0, Easing::Linear),
            kf(in_at + 10.0, 1.0, Easing::Linear),
            kf(out_at, 1.0, Easing::Linear),
            kf(out_at + 10.0, 0.0, Easing::Linear),
        ],
    );
}

/// Corner clock (time of day).
pub fn clock() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut bg = layer(
        "ck-bg",
        "Background",
        LayerKind::Rect,
        None,
        &[
            (X, n(1640.0)),
            (Y, n(60.0)),
            (Width, n(200.0)),
            (Height, n(64.0)),
            (Fill, hex("#0f1222e6")),
            (CornerRadius, n(10.0)),
        ],
    );
    fade(&mut bg, 0.0, 30.0);
    let mut time = layer(
        "ck-time",
        "Clock",
        LayerKind::Clock {
            mode: ClockMode::Time,
            format: "HH:mm:ss".into(),
            timezone: String::new(),
            target: String::new(),
            font: font(700, TextAlign::Center),
        },
        None,
        &[
            (X, n(1640.0)),
            (Y, n(60.0)),
            (Width, n(200.0)),
            (Height, n(64.0)),
            (FontSize, n(36.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    fade(&mut time, 4.0, 30.0);
    Template {
        id: "clock".into(),
        name: "Clock".into(),
        duration: 45.0,
        markers: vec![
            marker(15.0, "On air", MarkerKind::Pause),
            marker(30.0, "Out", MarkerKind::Out),
        ],
        fields: vec![],
        layers: vec![bg, time],
    }
}

/// News ticker: one headline per line of the `items` field.
pub fn ticker() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut bar = layer(
        "tk-bar",
        "Bar",
        LayerKind::Rect,
        None,
        &[
            (X, n(0.0)),
            (Y, n(990.0)),
            (Width, n(1920.0)),
            (Height, n(60.0)),
            (Fill, hex("#0f1222f0")),
        ],
    );
    bar.tracks.insert(
        Y,
        vec![
            kf(0.0, 1080.0, Easing::EaseOut),
            kf(15.0, 990.0, Easing::Linear),
            kf(60.0, 990.0, Easing::EaseIn),
            kf(75.0, 1080.0, Easing::Linear),
        ],
    );
    let mut label = layer(
        "tk-label",
        "Label",
        LayerKind::Text {
            text: "{{label}}".into(),
            font_family: "Inter".into(),
            font_weight: 800,
            align: TextAlign::Center,
            vertical_align: VerticalAlign::Middle,
            uppercase: true,
        },
        None,
        &[
            (X, n(0.0)),
            (Y, n(990.0)),
            (Width, n(220.0)),
            (Height, n(60.0)),
            (FontSize, n(26.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    label.tracks.insert(Y, bar.tracks[&Y].clone());
    let mut label_bg = layer(
        "tk-label-bg",
        "Label plate",
        LayerKind::Rect,
        None,
        &[
            (X, n(0.0)),
            (Y, n(990.0)),
            (Width, n(220.0)),
            (Height, n(60.0)),
            (Fill, hex("#ff3b5c")),
        ],
    );
    label_bg.tracks.insert(Y, bar.tracks[&Y].clone());
    let mut crawl = layer(
        "tk-crawl",
        "Crawl",
        LayerKind::Ticker {
            text: "{{items}}".into(),
            separator: "   •   ".into(),
            speed: 180.0,
            font: font(500, TextAlign::Left),
        },
        None,
        &[
            (X, n(240.0)),
            (Y, n(990.0)),
            (Width, n(1680.0)),
            (Height, n(60.0)),
            (FontSize, n(30.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    crawl.tracks.insert(Y, bar.tracks[&Y].clone());
    Template {
        id: "ticker".into(),
        name: "News ticker".into(),
        duration: 80.0,
        markers: vec![marker(20.0, "On air", MarkerKind::Pause), marker(60.0, "Out", MarkerKind::Out)],
        fields: vec![
            Field { key: "label".into(), label: "Label".into(), kind: FieldKind::Text, default: "Breaking".into() },
            Field {
                key: "items".into(),
                label: "Headlines (one per line)".into(),
                kind: FieldKind::Multiline,
                default: "Pulse CG renders HTML5, SDI and ST 2110 from one engine\nTickers, clocks and rolls are now built in\nOne project per show, one channel per studio".into(),
            },
        ],
        layers: vec![bar, label_bg, label, crawl],
    }
}

/// End credits roll.
pub fn credits() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut shade = layer(
        "cr-bg",
        "Shade",
        LayerKind::Rect,
        None,
        &[
            (X, n(0.0)),
            (Y, n(0.0)),
            (Width, n(1920.0)),
            (Height, n(1080.0)),
            (Fill, hex("#000000b3")),
        ],
    );
    fade(&mut shade, 0.0, 60.0);
    let mut roll = layer(
        "cr-roll",
        "Roll",
        LayerKind::Roll {
            text: "{{credits}}".into(),
            speed: 70.0,
            looping: false,
            font: font(500, TextAlign::Center),
        },
        None,
        &[
            (X, n(460.0)),
            (Y, n(0.0)),
            (Width, n(1000.0)),
            (Height, n(1080.0)),
            (FontSize, n(40.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    fade(&mut roll, 0.0, 60.0);
    Template {
        id: "credits".into(),
        name: "Credits roll".into(),
        duration: 75.0,
        markers: vec![
            marker(12.0, "Rolling", MarkerKind::Pause),
            marker(60.0, "Out", MarkerKind::Out),
        ],
        fields: vec![Field {
            key: "credits".into(),
            label: "Credits (one per line)".into(),
            kind: FieldKind::Multiline,
            default:
                "PULSE CG\n\nDirector\nJane Doe\n\nGraphics\nPulse CG Engine\n\nThanks for watching"
                    .into(),
        }],
        layers: vec![shade, roll],
    }
}

fn simple(id: &str, name: &str, duration: f64, fields: Vec<Field>, layers: Vec<Layer>) -> Template {
    Template {
        id: id.into(),
        name: name.into(),
        duration,
        markers: vec![
            marker(15.0, "On air", MarkerKind::Pause),
            marker(duration - 15.0, "Out", MarkerKind::Out),
        ],
        fields,
        layers,
    }
}

fn field(key: &str, label: &str, kind: FieldKind, default: &str) -> Field {
    Field {
        key: key.into(),
        label: label.into(),
        kind,
        default: default.into(),
    }
}

/// Analog studio clock.
pub fn analog_clock() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut c = layer(
        "ac-face",
        "Analog clock",
        LayerKind::AnalogClock {
            timezone: String::new(),
            seconds: true,
            accent: "#ff3b5c".into(),
        },
        None,
        &[
            (X, n(60.0)),
            (Y, n(60.0)),
            (Width, n(260.0)),
            (Height, n(260.0)),
            (Fill, hex("#0f1222e6")),
            (Stroke, hex("#ffffff")),
        ],
    );
    fade(&mut c, 0.0, 30.0);
    simple("analog-clock", "Analog clock", 45.0, vec![], vec![c])
}

/// Poll / results with animated bars and a counting total.
pub fn poll() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut bg = layer(
        "pl-bg",
        "Panel",
        LayerKind::Rect,
        None,
        &[
            (X, n(560.0)),
            (Y, n(240.0)),
            (Width, n(800.0)),
            (Height, n(560.0)),
            (Fill, hex("#0f1222f0")),
            (CornerRadius, n(18.0)),
        ],
    );
    fade(&mut bg, 0.0, 60.0);
    let mut title = layer(
        "pl-title",
        "Question",
        text("{{question}}", 800),
        None,
        &[
            (X, n(600.0)),
            (Y, n(270.0)),
            (Width, n(720.0)),
            (Height, n(90.0)),
            (FontSize, n(40.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    fade(&mut title, 4.0, 60.0);
    let mut chart = layer(
        "pl-chart",
        "Results",
        LayerKind::BarChart {
            text: "{{results}}".into(),
            percent: true,
            duration: 1.5,
            track: "#ffffff1f".into(),
            text_color: "#ffffff".into(),
            font: font(600, TextAlign::Left),
        },
        None,
        &[
            (X, n(600.0)),
            (Y, n(380.0)),
            (Width, n(720.0)),
            (Height, n(300.0)),
            (FontSize, n(30.0)),
            (Fill, hex("#7c5cff")),
        ],
    );
    fade(&mut chart, 8.0, 60.0);
    let mut total = layer(
        "pl-total",
        "Total votes",
        LayerKind::Counter {
            from: "0".into(),
            to: "{{votes}}".into(),
            duration: 2.0,
            decimals: 0,
            prefix: String::new(),
            suffix: " votes".into(),
            grouping: true,
            font: font(500, TextAlign::Right),
        },
        None,
        &[
            (X, n(600.0)),
            (Y, n(700.0)),
            (Width, n(720.0)),
            (Height, n(70.0)),
            (FontSize, n(28.0)),
            (Fill, hex("#a3a8bf")),
        ],
    );
    fade(&mut total, 8.0, 60.0);
    simple(
        "poll",
        "Poll results",
        75.0,
        vec![
            field(
                "question",
                "Question",
                FieldKind::Text,
                "Should the match be replayed?",
            ),
            field(
                "results",
                "Results (Label: value per line)",
                FieldKind::Multiline,
                "Yes: 6420\nNo: 3110\nDon't know: 870",
            ),
            field("votes", "Total votes", FieldKind::Number, "10400"),
        ],
        vec![bg, title, chart, total],
    )
}

/// QR code with a call to action.
pub fn qr_code() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut code = layer(
        "qr-code",
        "QR code",
        LayerKind::QrCode {
            data: "{{url}}".into(),
            background: "#ffffff".into(),
        },
        None,
        &[
            (X, n(1600.0)),
            (Y, n(700.0)),
            (Width, n(240.0)),
            (Height, n(240.0)),
            (Fill, hex("#0f1222")),
            (CornerRadius, n(0.0)),
        ],
    );
    fade(&mut code, 0.0, 30.0);
    let mut cta = layer(
        "qr-text",
        "Call to action",
        text("{{cta}}", 700),
        None,
        &[
            (X, n(1600.0)),
            (Y, n(950.0)),
            (Width, n(240.0)),
            (Height, n(50.0)),
            (FontSize, n(26.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    if let LayerKind::Text { align, .. } = &mut cta.kind {
        *align = TextAlign::Center;
    }
    fade(&mut cta, 4.0, 30.0);
    simple(
        "qr-code",
        "QR code",
        45.0,
        vec![
            field(
                "url",
                "Link",
                FieldKind::Text,
                "https://github.com/DamienP2/CG",
            ),
            field("cta", "Text", FieldKind::Text, "Scan me"),
        ],
        vec![code, cta],
    )
}

/// "Live in" countdown to a time of day.
pub fn countdown() -> Template {
    use Prop::*;
    let n = Value::Number;
    let mut bg = layer(
        "cd-bg",
        "Plate",
        LayerKind::Rect,
        None,
        &[
            (X, n(710.0)),
            (Y, n(420.0)),
            (Width, n(500.0)),
            (Height, n(240.0)),
            (Fill, hex("#0f1222f0")),
            (CornerRadius, n(20.0)),
        ],
    );
    fade(&mut bg, 0.0, 30.0);
    let mut label = layer(
        "cd-label",
        "Label",
        LayerKind::Typewriter {
            text: "{{label}}".into(),
            speed: 18.0,
            cursor: false,
            font: font(600, TextAlign::Center),
        },
        None,
        &[
            (X, n(710.0)),
            (Y, n(440.0)),
            (Width, n(500.0)),
            (Height, n(60.0)),
            (FontSize, n(30.0)),
            (Fill, hex("#ff3b5c")),
        ],
    );
    fade(&mut label, 4.0, 30.0);
    let mut clock = layer(
        "cd-time",
        "Countdown",
        LayerKind::Clock {
            mode: ClockMode::Countdown,
            format: "HH:mm:ss".into(),
            timezone: String::new(),
            target: "{{target}}".into(),
            font: font(800, TextAlign::Center),
        },
        None,
        &[
            (X, n(710.0)),
            (Y, n(500.0)),
            (Width, n(500.0)),
            (Height, n(140.0)),
            (FontSize, n(96.0)),
            (Fill, hex("#ffffff")),
        ],
    );
    fade(&mut clock, 4.0, 30.0);
    simple(
        "countdown",
        "Countdown",
        45.0,
        vec![
            field("label", "Label", FieldKind::Text, "LIVE IN"),
            field(
                "target",
                "Target (HH:mm or date-time)",
                FieldKind::Text,
                "20:00",
            ),
        ],
        vec![bg, label, clock],
    )
}

pub fn demo_project() -> Project {
    let mut data = BTreeMap::new();
    data.insert("name".to_string(), "Marie Curie".to_string());
    data.insert("title".to_string(), "Physicist & chemist".to_string());
    Project {
        id: "demo".into(),
        name: "Demo show".into(),
        description: String::new(),
        width: 1920,
        height: 1080,
        frame_rate: FrameRate::new(50, 1),
        templates: vec![
            lower_third(),
            score_bug(),
            clock(),
            ticker(),
            credits(),
            analog_clock(),
            poll(),
            qr_code(),
            countdown(),
        ],
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
            RundownItem {
                id: new_id(),
                name: "Clock".into(),
                template_id: "clock".into(),
                layer: 30,
                data: BTreeMap::new(),
            },
            RundownItem {
                id: new_id(),
                name: "Ticker – headlines".into(),
                template_id: "ticker".into(),
                layer: 40,
                data: BTreeMap::new(),
            },
            RundownItem {
                id: new_id(),
                name: "Credits".into(),
                template_id: "credits".into(),
                layer: 50,
                data: BTreeMap::new(),
            },
            RundownItem {
                id: new_id(),
                name: "Analog clock".into(),
                template_id: "analog-clock".into(),
                layer: 31,
                data: BTreeMap::new(),
            },
            RundownItem {
                id: new_id(),
                name: "Poll".into(),
                template_id: "poll".into(),
                layer: 60,
                data: BTreeMap::new(),
            },
            RundownItem {
                id: new_id(),
                name: "QR code".into(),
                template_id: "qr-code".into(),
                layer: 70,
                data: BTreeMap::new(),
            },
            RundownItem {
                id: new_id(),
                name: "Countdown".into(),
                template_id: "countdown".into(),
                layer: 80,
                data: BTreeMap::new(),
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
