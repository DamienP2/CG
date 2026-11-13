//! The Ticker and Credits widgets of before, made into the Builder's bricks
//! as a template is read: a folder repeated once per row of its list (its
//! items, its entries), going by in its box ([`crate::lists`]). The folder
//! keeps the widget's id (its Logic, its operator clock still find it). A
//! scrolling Text and a Credits roll of older projects first become the
//! widget they were drawn as: horizontal, a Ticker (its lines are the items);
//! vertical, Credits (its lines are the names, at its speed in px/s, in its
//! font).
//!
//! What the bricks cannot do is dropped: scrolling right or down,
//! transitions other than a slide, a number of passes, an empty-list
//! message, QR code lines, space styles, the value the credits were linked
//! to. A setting missing from the layer is the widget's default of before
//! (as the server wrote them), so a template comes out as the Designer
//! converted it when it did.

use serde::{de::Error as _, Deserialize, Deserializer};
use serde_json::{json, Map, Value};

use crate::model::Layer;

type Obj = Map<String, Value>;

/// `Template::layers` as read: the widgets of before converted, then typed.
pub(crate) fn layers<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Layer>, D::Error> {
    convert(Vec::<Value>::deserialize(d)?)
        .into_iter()
        .map(|l| serde_json::from_value(l).map_err(D::Error::custom))
        .collect()
}

/// The layers (as JSON) with every widget of before made into a list folder
/// and its elements, in its place.
pub fn convert(layers: Vec<Value>) -> Vec<Value> {
    if !layers.iter().any(|l| old(l).is_some()) {
        return layers;
    }
    let mut out = Vec::with_capacity(layers.len());
    for l in layers {
        match (old(&l), l.as_object()) {
            (Some(Old::Ticker), Some(o)) => out.extend(ticker(o)),
            (Some(Old::Credits), Some(o)) => out.extend(credits(o)),
            (Some(Old::Crawl), Some(o)) => out.extend(ticker(&crawl_text(o))),
            (Some(Old::Scroll), Some(o)) => out.extend(credits(&rolled_text(o, 120.0))),
            (Some(Old::Roll), Some(o)) => out.extend(credits(&rolled_text(o, 60.0))),
            _ => out.push(l),
        }
    }
    out
}

enum Old {
    Ticker,
    Credits,
    /// A Text scrolling horizontally.
    Crawl,
    /// A Text scrolling vertically.
    Scroll,
    /// A Credits roll (its text going up).
    Roll,
}

fn old(l: &Value) -> Option<Old> {
    match l.get("type")?.as_str()? {
        "ticker" => Some(Old::Ticker),
        "credits" => Some(Old::Credits),
        "roll" => Some(Old::Roll),
        "text" => match l.get("scroll").and_then(Value::as_str) {
            Some("horizontal") => Some(Old::Crawl),
            Some("vertical") => Some(Old::Scroll),
            _ => None,
        },
        _ => None,
    }
}

// ------------------------------------------------------------- reading --

const NULL: Value = Value::Null;

fn at<'a>(o: &'a Obj, k: &str) -> &'a Value {
    o.get(k).unwrap_or(&NULL)
}

fn num(v: &Value, d: f64) -> f64 {
    v.as_f64().filter(|x| x.is_finite()).unwrap_or(d)
}

/// A setting the widget kept in single precision: the value it was written
/// with (its shortest digits).
fn num32(v: &Value, d: f32) -> f64 {
    let x = v.as_f64().filter(|x| x.is_finite()).map_or(d, |x| x as f32);
    x.to_string().parse().unwrap_or(f64::from(x))
}

fn text<'a>(v: &'a Value, d: &'a str) -> &'a str {
    v.as_str().unwrap_or(d)
}

/// What a script would take for true.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

fn list(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

// ------------------------------------------------------------- writing --

/// A number as a script writes it (whole numbers without decimals).
fn n(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// `#rrggbb[aa]` as the colour a prop holds (0..1).
fn color(hex: &str, fallback: Value) -> Value {
    let h = hex.trim();
    let h = h.strip_prefix('#').unwrap_or(h);
    if !matches!(h.len(), 6 | 8) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fallback;
    }
    let p = |i: usize| n(f64::from(u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0)) / 255.0);
    json!([p(0), p(2), p(4), if h.len() == 8 { p(6) } else { n(1.0) }])
}

fn obj_of(pairs: Vec<(&str, Value)>) -> Obj {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn layer(id: String, name: &str, kind: &str, parent: Value, props: Obj, more: Obj) -> Value {
    let mut o = obj_of(vec![
        ("id", json!(id)),
        ("name", json!(name)),
        ("type", json!(kind)),
        ("parent", parent),
        ("visible", json!(true)),
        ("locked", json!(false)),
        ("props", Value::Object(props)),
        ("tracks", json!({})),
        ("bindings", json!({})),
    ]);
    o.extend(more);
    Value::Object(o)
}

fn text_layer(
    id: String,
    name: &str,
    parent: Value,
    body: &str,
    props: Obj,
    style: Obj,
    more: Obj,
) -> Value {
    let mut o = obj_of(vec![
        ("text", json!(body)),
        ("align", json!("left")),
        ("verticalAlign", json!("middle")),
        ("uppercase", json!(false)),
    ]);
    o.extend(style);
    o.extend(more);
    layer(id, name, "text", parent, props, o)
}

fn with(style: &Obj, more: Vec<(&str, Value)>) -> Obj {
    let mut o = style.clone();
    o.extend(obj_of(more));
    o
}

fn parent_of(old: &Obj) -> Value {
    match at(old, "parent") {
        Value::String(s) => json!(s),
        _ => Value::Null,
    }
}

fn box_props(x: f64, y: f64, w: f64, h: f64) -> Vec<(&'static str, Value)> {
    vec![("x", n(x)), ("y", n(y)), ("width", n(w)), ("height", n(h))]
}

/// What the folder of a converted widget keeps of it: its place in the timeline, its start.
fn folder(old: &Obj, props: Obj, list: Value, roll: Value) -> Value {
    let mut more = Obj::new();
    for k in [
        "span",
        "motion",
        "manualStart",
        "startOn",
        "startTrigger",
        "liveChanges",
        "timeline",
    ] {
        if let Some(v) = old.get(k).filter(|v| !v.is_null()) {
            more.insert(k.into(), v.clone());
        }
    }
    more.insert("visible".into(), json!(at(old, "visible") != &json!(false)));
    more.insert("locked".into(), json!(truthy(at(old, "locked"))));
    let tracks = match at(old, "tracks") {
        Value::Null => json!({}),
        t => t.clone(),
    };
    more.insert("tracks".into(), tracks);
    more.insert("clip".into(), json!(true));
    more.insert("list".into(), list);
    more.insert("roll".into(), roll);
    layer(
        text(at(old, "id"), "").into(),
        text(at(old, "name"), ""),
        "group",
        parent_of(old),
        props,
        more,
    )
}

fn roll(
    mode: &str,
    dir: &str,
    by: &str,
    speed: f64,
    duration: f64,
    pause: f64,
    fade: f64,
) -> Value {
    json!({
        "mode": mode, "dir": dir, "by": by, "speed": n(speed),
        "duration": n(duration), "pause": n(pause), "fade": n(fade)
    })
}

// -------------------------------------------------------------- ticker --

/// The single `{{key}}` a text is wired to.
fn field(t: &str) -> Option<&str> {
    let k = t.trim().strip_prefix("{{")?.strip_suffix("}}")?.trim();
    (!k.is_empty() && !k.contains(['{', '}']) && !k.contains(char::is_whitespace)).then_some(k)
}

/// A ticker: its items (a field's lines, or its own with their categories) going by.
fn ticker(old: &Obj) -> Vec<Value> {
    let id = text(at(old, "id"), "").to_string();
    let p = obj(at(old, "props"));
    let pn = |k: &str, d: f64| num(p.get(k).unwrap_or(&NULL), d);
    let (x, y, w, h) = (
        pn("x", 0.0),
        pn("y", 0.0),
        pn("width", 1920.0),
        pn("height", 64.0),
    );
    let size = pn("fontSize", 32.0);
    let fill = p.get("fill").cloned().unwrap_or(json!([1, 1, 1, 1]));
    let style = obj_of(vec![
        ("fontFamily", json!(text(at(old, "fontFamily"), "Inter"))),
        ("fontWeight", n(num(at(old, "fontWeight"), 400.0))),
        ("uppercase", json!(truthy(at(old, "uppercase")))),
    ]);
    let crawl = text(at(old, "mode"), "crawl") == "crawl";
    let parent = parent_of(old);
    let mut out = Vec::new();
    // The band and the title block: drawn beside the folder (they do not go by).
    if truthy(at(old, "barBg")) {
        let mut props = obj_of(box_props(x, y, w, h));
        props.insert(
            "fill".into(),
            color(text(at(old, "barBg"), ""), json!([0, 0, 0, 0.8])),
        );
        out.push(layer(
            format!("{id}-bar"),
            "Fond",
            "rect",
            parent.clone(),
            props,
            Obj::new(),
        ));
    }
    let title = obj(at(old, "title"));
    let tt = |k: &str| title.get(k).unwrap_or(&NULL);
    let tw = if truthy(tt("on")) {
        num32(tt("w"), 190.0)
    } else {
        0.0
    };
    if truthy(tt("on")) {
        let mut props = obj_of(box_props(x, y, tw, h));
        props.insert(
            "fill".into(),
            color(text(tt("bg"), "#ff3b5c"), json!([0.88, 0.11, 0.28, 1])),
        );
        out.push(layer(
            format!("{id}-tbg"),
            "Bloc du titre",
            "rect",
            parent.clone(),
            props,
            Obj::new(),
        ));
        let mut props = obj_of(box_props(x, y, tw, h));
        props.insert("fontSize".into(), n(size * 0.8));
        props.insert(
            "fill".into(),
            color(text(tt("color"), "#ffffff"), json!([1, 1, 1, 1])),
        );
        out.push(text_layer(
            format!("{id}-ttl"),
            "Titre",
            parent.clone(),
            text(tt("text"), "INFO"),
            props,
            with(
                &style,
                vec![("fontWeight", n(800.0)), ("align", json!("center"))],
            ),
            Obj::new(),
        ));
    }
    // Its rows: a field ({{items}}: one per line), else its own items, else its text's lines.
    let body = text(at(old, "text"), "");
    let key = field(body);
    let items = list(at(old, "items"));
    let cats = list(at(old, "cats"));
    let bound = obj(at(old, "settingBindings"));
    let mut rows: Vec<Value> = Vec::new();
    if key.is_none() && !items.is_empty() {
        for (i, it) in items.iter().enumerate() {
            let cat = match bound.get(&format!("items.{i}.cat")) {
                Some(Value::String(k)) if !k.is_empty() => format!("{{{{{k}}}}}"),
                _ => text(it.get("cat").unwrap_or(&NULL), "").to_string(),
            };
            let mut row = obj_of(vec![
                ("texte", json!(text(it.get("text").unwrap_or(&NULL), ""))),
                ("catégorie", json!(cat)),
            ]);
            if it.get("on") == Some(&json!(false)) {
                row.insert("on".into(), json!("false"));
            }
            rows.push(Value::Object(row));
        }
    } else if key.is_none() {
        rows = body
            .split('\n')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| json!({ "texte": t }))
            .collect();
    }
    let mut lst = obj_of(vec![
        ("key", json!(key.unwrap_or(""))),
        ("layout", json!(if crawl { "row" } else { "column" })),
        (
            "gap",
            n(if crawl {
                num32(at(old, "spacing"), 0.0)
            } else {
                0.0
            }),
        ),
    ]);
    if !rows.is_empty() {
        lst.insert("rows".into(), Value::Array(rows));
    }
    let rl = if crawl {
        let fade = if truthy(at(old, "fade")) {
            num32(at(old, "fadeW"), 90.0)
        } else {
            0.0
        };
        let speed = num(at(old, "speed"), 180.0);
        roll("continuous", "left", "speed", speed, 30.0, 4.0, fade)
    } else {
        let pause = num(at(old, "itemDur"), 5.0);
        roll("one", "up", "speed", 120.0, 30.0, pause, 0.0)
    };
    out.push(folder(
        old,
        obj_of(box_props(x + tw, y, w - tw, h)),
        Value::Object(lst),
        rl,
    ));
    // Inside: the separator, the category, the item.
    let inside = json!(id);
    let mut from = 0.0;
    let sep = text(at(old, "sepType"), "text");
    if crawl && (sep == "symbol" || sep == "text") {
        let glyph = if sep == "symbol" {
            text(at(old, "sepSymbol"), "●").to_string()
        } else {
            let t = text(at(old, "separator"), "   •   ").trim();
            if t.is_empty() { "•" } else { t }.to_string()
        };
        let mut props = obj_of(vec![
            ("x", n(0.0)),
            ("y", n(0.0)),
            ("width", n(size)),
            ("height", n(h)),
            ("fontSize", n(size * 0.6)),
        ]);
        props.insert(
            "fill".into(),
            color(text(at(old, "sepColor"), ""), fill.clone()),
        );
        out.push(text_layer(
            format!("{id}-sep"),
            "Séparateur",
            inside.clone(),
            &glyph,
            props,
            with(
                &style,
                vec![("align", json!("center")), ("overflow", json!("visible"))],
            ),
            Obj::new(),
        ));
        from = size + 12.0;
    } else if crawl && sep == "image" && truthy(at(old, "sepImage")) {
        out.push(layer(
            format!("{id}-sep"),
            "Séparateur",
            "image",
            inside.clone(),
            obj_of(box_props(0.0, h * 0.2, h * 0.6, h * 0.6)),
            obj_of(vec![
                ("src", json!(text(at(old, "sepImage"), ""))),
                ("fit", json!("contain")),
            ]),
        ));
        from = h * 0.6 + 12.0;
    }
    if !cats.is_empty() {
        let c = |c: &Value, k: &str, d: &'static str| -> String {
            text(c.get(k).unwrap_or(&NULL), d).to_string()
        };
        let cw = cats.iter().fold(size * 1.2, |m, x| {
            let len = c(x, "name", "NEW").encode_utf16().count() as f64;
            m.max(len * size * 0.62 + 24.0)
        });
        let by = |k: &str, d: &'static str| -> Value {
            let m: Obj = cats
                .iter()
                .map(|x| (c(x, "name", "NEW"), json!(c(x, k, d))))
                .collect();
            Value::Object(m)
        };
        let filled = json!({ "col": "catégorie", "test": "filled" });
        let in_list = |k: &str, d: &'static str| {
            obj_of(vec![(
                "inList",
                json!({
                    "when": filled,
                    "colors": [{ "prop": "fill", "col": "catégorie", "map": by(k, d) }]
                }),
            )])
        };
        let chip = |more: Vec<(&'static str, Value)>| {
            let mut props = obj_of(box_props(from, h * 0.18, cw, h * 0.64));
            props.extend(obj_of(more));
            props
        };
        out.push(layer(
            format!("{id}-cat"),
            "Catégorie",
            "rect",
            inside.clone(),
            chip(vec![
                ("cornerRadius", n(4.0)),
                (
                    "fill",
                    color(&c(&cats[0], "bg", "#7c5cff"), json!([0.15, 0.39, 0.92, 1])),
                ),
            ]),
            in_list("bg", "#7c5cff"),
        ));
        out.push(text_layer(
            format!("{id}-catt"),
            "Texte de la catégorie",
            inside.clone(),
            "{{catégorie}}",
            chip(vec![
                ("fontSize", n(size * 0.7)),
                (
                    "fill",
                    color(&c(&cats[0], "color", "#ffffff"), json!([1, 1, 1, 1])),
                ),
            ]),
            with(
                &style,
                vec![("fontWeight", n(700.0)), ("align", json!("center"))],
            ),
            in_list("color", "#ffffff"),
        ));
        from += cw + 12.0;
    }
    let mut props = obj_of(vec![
        ("x", n(from)),
        ("y", n(0.0)),
        ("width", n(f64::max(200.0, w - tw - from))),
        ("height", n(h)),
        ("fontSize", n(size)),
    ]);
    props.insert("fill".into(), fill);
    out.push(text_layer(
        format!("{id}-txt"),
        "Texte",
        inside,
        "{{texte}}",
        props,
        with(
            &style,
            vec![("overflow", json!(if crawl { "visible" } else { "fit" }))],
        ),
        Obj::new(),
    ));
    out
}

// ------------------------------------------------------------- credits --

/// A level of the credits (section, role, name): its size, colour and font.
struct Look {
    size: f64,
    fill: Value,
    style: Obj,
}

/// Credits: their entries (sections, roles and names, logos, spaces) going up, or by pages.
fn credits(old: &Obj) -> Vec<Value> {
    let id = text(at(old, "id"), "").to_string();
    let p = obj(at(old, "props"));
    let pn = |k: &str, d: f64| num(p.get(k).unwrap_or(&NULL), d);
    let (x, y, w, h) = (
        pn("x", 0.0),
        pn("y", 0.0),
        pn("width", 1200.0),
        pn("height", 700.0),
    );
    let st = obj(at(old, "st"));
    let font = text(at(old, "font"), "Inter");
    let look = |k: &str, size: f32, col: &str, weight: f64, upper: bool| {
        let s = obj(st.get(k).unwrap_or(&NULL));
        let s = |k: &str| s.get(k).cloned().unwrap_or(NULL);
        Look {
            size: num32(&s("size"), size),
            fill: color(text(&s("color"), col), json!([1, 1, 1, 1])),
            style: obj_of(vec![
                ("fontFamily", json!(font)),
                ("fontWeight", n(num(&s("weight"), weight))),
                ("uppercase", json!(s("upper").as_bool().unwrap_or(upper))),
            ]),
        }
    };
    let sec = look("section", 30.0, "#a594ff", 900.0, true);
    let role = look("role", 26.0, "#a3a9bd", 600.0, true);
    let name = look("name", 38.0, "#ffffff", 800.0, false);
    let mode = text(at(old, "mode"), "roll");
    let rows: Vec<Value> = list(at(old, "entries"))
        .iter()
        .map(|e| {
            let f = |k: &str, d: &str| json!(text(e.get(k).unwrap_or(&NULL), d));
            json!({ "type": f("kind", "line"), "a": f("a", ""), "b": f("b", "") })
        })
        .collect();
    let layout = match mode {
        "crawl" => "row",
        "pages" => "grid",
        _ => "column",
    };
    let mut lst = obj_of(vec![
        ("key", json!("")),
        ("rows", Value::Array(rows)),
        ("layout", json!(layout)),
    ]);
    if mode == "pages" {
        lst.insert("cols".into(), n(1.0));
    }
    lst.insert("gap".into(), n(num32(at(old, "lineGap"), 10.0)));
    let fade = at(old, "fade").as_bool().unwrap_or(true);
    let pxs = num(at(old, "pxs"), 120.0);
    let fade_by = |px: f64| if fade { px } else { 0.0 };
    let rl = match mode {
        "pages" => {
            let pause = num(at(old, "cardDur"), 4.0);
            roll("one", "up", "speed", 120.0, 30.0, pause, 0.0)
        }
        "crawl" => roll("continuous", "left", "speed", pxs, 30.0, 4.0, fade_by(80.0)),
        _ if text(at(old, "speedMode"), "duration") == "pxs" => {
            roll("continuous", "up", "speed", pxs, 30.0, 4.0, fade_by(120.0))
        }
        _ => {
            let duration = num(at(old, "duration"), 40.0);
            roll(
                "continuous",
                "up",
                "duration",
                60.0,
                duration,
                4.0,
                fade_by(120.0),
            )
        }
    };
    let is = |v: &str| {
        obj_of(vec![(
            "inList",
            json!({ "when": { "col": "type", "test": "is", "value": v } }),
        )])
    };
    let gutter = num32(at(old, "gutter"), 40.0);
    let half = (w - gutter) / 2.0;
    let line_h = role.size.max(name.size) * 1.5;
    let inside = json!(id);
    let props = |w: f64, h: f64, look: Option<&Look>| {
        let mut o = obj_of(box_props(0.0, 0.0, w, h));
        if let Some(l) = look {
            o.insert("fontSize".into(), n(l.size));
            o.insert("fill".into(), l.fill.clone());
        }
        o
    };
    let mut name_props = props(half, line_h, Some(&name));
    name_props.insert("x".into(), n(half + gutter));
    let mut logo = obj_of(vec![("src", json!("{{a}}")), ("fit", json!("contain"))]);
    logo.extend(is("logo"));
    let mut logo_props = props(w * 0.3, num32(at(old, "logoH"), 130.0), None);
    logo_props.insert("x".into(), n((w - w * 0.3) / 2.0));
    let mut space_props = props(w, num32(at(old, "spaceH"), 40.0), None);
    space_props.insert("fill".into(), json!([0, 0, 0, 0]));
    vec![
        folder(old, obj_of(box_props(x, y, w, h)), Value::Object(lst), rl),
        text_layer(
            format!("{id}-sec"),
            "Section",
            inside.clone(),
            "{{a}}",
            props(w, sec.size * 1.8, Some(&sec)),
            with(
                &sec.style,
                vec![
                    ("align", json!("center")),
                    ("verticalAlign", json!("bottom")),
                ],
            ),
            is("section"),
        ),
        text_layer(
            format!("{id}-role"),
            "Rôle",
            inside.clone(),
            "{{a}}",
            props(half, line_h, Some(&role)),
            with(&role.style, vec![("align", json!("right"))]),
            is("line"),
        ),
        text_layer(
            format!("{id}-name"),
            "Nom",
            inside.clone(),
            "{{b}}",
            name_props,
            name.style.clone(),
            is("line"),
        ),
        layer(
            format!("{id}-logo"),
            "Logo",
            "image",
            inside.clone(),
            logo_props,
            logo,
        ),
        layer(
            format!("{id}-space"),
            "Espace",
            "rect",
            inside,
            space_props,
            is("space"),
        ),
    ]
}

// --------------------------------------------- scrolling texts, rolls --

/// What a layer keeps of itself as the widget it becomes.
fn base(l: &Obj, kind: &str) -> Obj {
    let mut o = Obj::new();
    for k in [
        "id",
        "name",
        "parent",
        "visible",
        "locked",
        "props",
        "tracks",
        "span",
        "motion",
        "manualStart",
        "startOn",
        "startTrigger",
        "liveChanges",
        "timeline",
    ] {
        if let Some(v) = l.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    o.insert("type".into(), json!(kind));
    o
}

/// A Text scrolling horizontally: the Ticker it was drawn as (its lines are the items).
fn crawl_text(l: &Obj) -> Obj {
    let mut o = base(l, "ticker");
    let upper = truthy(at(l, "uppercase")) || at(l, "transform") == &json!("upper");
    o.extend(obj_of(vec![
        ("text", json!(text(at(l, "text"), ""))),
        ("separator", json!(text(at(l, "separator"), "   •   "))),
        ("speed", n(num(at(l, "speed"), 120.0))),
        ("fontFamily", json!(text(at(l, "fontFamily"), "Inter"))),
        ("fontWeight", n(num(at(l, "fontWeight"), 400.0))),
        ("uppercase", json!(upper)),
    ]));
    o
}

/// A Text scrolling vertically, or a Credits roll: Credits (its lines are the
/// names, at its speed in px/s, in its font); wired to one value (`{{key}}`),
/// they read it.
fn rolled_text(l: &Obj, speed: f64) -> Obj {
    let mut o = base(l, "credits");
    let body = text(at(l, "text"), "");
    let t = body.trim();
    if t.starts_with("{{") && t.ends_with("}}") && t.matches("{{").count() == 1 {
        o.insert("link".into(), json!(t));
    } else {
        o.insert("entries".into(), Value::Array(parse(body)));
    }
    o.insert("speedMode".into(), json!("pxs"));
    o.insert("pxs".into(), n(num(at(l, "speed"), speed)));
    o.insert("font".into(), json!(text(at(l, "fontFamily"), "Inter")));
    o
}

/// Credits from text: "# Section", "Role | Name" (or `;` / tab), "[logo
/// /assets/x.png]", "[qr link | caption]", a line alone = a name, an empty
/// line = a space.
fn parse(body: &str) -> Vec<Value> {
    let entry = |kind: &str, a: &str, b: &str| json!({ "kind": kind, "a": a, "b": b });
    let mut out: Vec<Value> = Vec::new();
    for line in body.lines() {
        let l = line.trim();
        if l.is_empty() {
            if out.last().is_some_and(|e| e["kind"] != "space") {
                out.push(entry("space", "", ""));
            }
            continue;
        }
        if let Some(s) = l.strip_prefix('#') {
            out.push(entry("section", s.trim_start_matches('#').trim(), ""));
            continue;
        }
        let low = l.to_lowercase();
        let inner = |from: usize| l.get(from..l.len() - 1).unwrap_or("");
        if low.starts_with("[logo") && l.ends_with(']') {
            let v = inner(5).trim();
            out.push(entry("logo", if v.is_empty() { "PULSE TV" } else { v }, ""));
            continue;
        }
        if low.starts_with("[qr") && l.ends_with(']') {
            let v = inner(3);
            let (link, caption) = v.split_once('|').unwrap_or((v, ""));
            out.push(entry("qr", link.trim(), caption.trim()));
            continue;
        }
        let parts: Vec<&str> = line.split(['|', ';', '\t']).collect();
        if parts.len() > 1 {
            let b = parts[1..]
                .iter()
                .map(|s| s.trim())
                .collect::<Vec<_>>()
                .join(" ");
            out.push(entry("line", parts[0].trim(), b.trim()));
        } else {
            out.push(entry("line", "", l));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LayerKind, ListLayout, Prop, RollBy, RollDir, RollMode, Template};

    fn read(layers: Value) -> Template {
        serde_json::from_value(json!({
            "id": "t", "name": "T", "duration": 50.0, "layers": layers
        }))
        .unwrap()
    }

    fn get<'a>(t: &'a Template, id: &str) -> &'a Layer {
        t.layers
            .iter()
            .find(|l| l.id == id)
            .unwrap_or_else(|| panic!("no {id} in {:?}", ids(t)))
    }

    fn ids(t: &Template) -> Vec<&str> {
        t.layers.iter().map(|l| l.id.as_str()).collect()
    }

    fn num_of(l: &Layer, p: Prop) -> f64 {
        l.props.get(&p).and_then(|v| v.as_number()).unwrap()
    }

    fn body(l: &Layer) -> &str {
        match &l.kind {
            LayerKind::Text { text, .. } => text,
            k => panic!("{k:?}"),
        }
    }

    #[test]
    fn a_ticker_with_its_items_categories_and_title_becomes_a_list_folder() {
        let t = read(json!([
            { "id": "bar", "name": "Bandeau", "type": "group", "props": {} },
            {
                "id": "k", "name": "Ticker", "parent": "bar", "type": "ticker",
                "text": "", "separator": "   ", "speed": 150.0,
                "fontFamily": "Oswald", "fontWeight": 600, "uppercase": true,
                "mode": "crawl", "sepType": "symbol", "sepSymbol": "■", "sepColor": "#ff0000",
                "items": [
                    { "cat": "SPORT", "text": "Victoire", "on": true },
                    { "cat": "", "text": "Pluie", "on": false },
                    { "cat": "INFO", "text": "Élection", "on": true }
                ],
                "cats": [
                    { "name": "SPORT", "bg": "#00ff00", "color": "#000000", "text": "" },
                    { "name": "INFO", "bg": "#0000ff", "color": "#ffffff", "text": "" }
                ],
                "title": { "on": true, "text": "DIRECT", "bg": "#112233", "color": "#ffffff", "w": 200.0 },
                "barBg": "#000000cc", "spacing": 28.0, "fade": true, "fadeW": 60.0,
                "manualStart": true,
                "props": { "x": 0.0, "y": 1000.0, "width": 1920.0, "height": 60.0, "fontSize": 30.0, "fill": [1.0, 1.0, 1.0, 1.0] },
                "settingBindings": { "items.2.cat": "rubrique" }
            }
        ]));
        assert_eq!(
            ids(&t),
            ["bar", "k-bar", "k-tbg", "k-ttl", "k", "k-sep", "k-cat", "k-catt", "k-txt"]
        );
        // The band and the title beside the folder, in the bar.
        let band = get(&t, "k-bar");
        assert_eq!(band.parent.as_deref(), Some("bar"));
        assert_eq!(num_of(band, Prop::Width), 1920.0);
        let fill = band.props[&Prop::Fill].as_color().unwrap().0;
        assert!((fill[3] - 0.8).abs() < 1e-6, "{fill:?}");
        assert_eq!(body(get(&t, "k-ttl")), "DIRECT");
        assert_eq!(num_of(get(&t, "k-ttl"), Prop::FontSize), 24.0);
        // The folder: the widget's id, its place after the title, its rows going left.
        let f = get(&t, "k");
        assert!(matches!(f.kind, LayerKind::Group { clip: true, .. }));
        assert_eq!(f.parent.as_deref(), Some("bar"));
        assert!(f.manual_start);
        assert_eq!(
            (num_of(f, Prop::X), num_of(f, Prop::Width)),
            (200.0, 1720.0)
        );
        let list = f.list.as_ref().unwrap();
        assert_eq!(
            (list.key.as_str(), list.layout, list.gap),
            ("", ListLayout::Row, 28.0)
        );
        assert_eq!(list.rows.len(), 3);
        assert_eq!(list.rows[0]["texte"], "Victoire");
        assert_eq!(list.rows[0]["catégorie"], "SPORT");
        assert_eq!(list.rows[1]["on"], "false");
        assert_eq!(list.rows[2]["catégorie"], "{{rubrique}}");
        let r = f.roll.as_ref().unwrap();
        assert_eq!(
            (r.mode, r.dir, r.by, r.speed, r.fade),
            (
                RollMode::Continuous,
                RollDir::Left,
                RollBy::Speed,
                150.0,
                60.0
            )
        );
        // Inside: the separator, the category chip coloured by its column, the item.
        let sep = get(&t, "k-sep");
        assert_eq!((body(sep), sep.parent.as_deref()), ("■", Some("k")));
        assert_eq!(num_of(sep, Prop::FontSize), 18.0);
        let chip = get(&t, "k-cat");
        let il = chip.in_list.as_ref().unwrap();
        assert_eq!(il.when.as_ref().unwrap().col, "catégorie");
        assert_eq!(il.colors[0].map["INFO"], "#0000ff");
        // "SPORT" (5) × 30 × 0.62 + 24 = 117 > 36; at 30 + 12.
        assert_eq!(
            (num_of(chip, Prop::X), num_of(chip, Prop::Width)),
            (42.0, 117.0)
        );
        assert_eq!(body(get(&t, "k-catt")), "{{catégorie}}");
        let txt = get(&t, "k-txt");
        assert_eq!(body(txt), "{{texte}}");
        assert_eq!(num_of(txt, Prop::X), 171.0);
        let LayerKind::Text {
            font_family,
            font_weight,
            uppercase,
            overflow,
            ..
        } = &txt.kind
        else {
            panic!()
        };
        assert_eq!(
            (font_family.as_str(), *font_weight, *uppercase, *overflow),
            ("Oswald", 600, true, crate::model::TextOverflow::Visible)
        );
    }

    #[test]
    fn a_flip_ticker_wired_to_a_field_goes_up_one_item_at_a_time() {
        let t = read(json!([{
            "id": "k", "name": "Infos", "type": "ticker", "text": "{{ titres }}",
            "mode": "flip", "itemDur": 6.0, "items": [{ "text": "ignored" }],
            "props": { "x": 100.0, "y": 50.0, "width": 800.0, "height": 70.0 }
        }]));
        assert_eq!(ids(&t), ["k", "k-txt"], "no separator but in a crawl");
        let f = get(&t, "k");
        let list = f.list.as_ref().unwrap();
        assert_eq!(
            (list.key.as_str(), list.layout, list.rows.len()),
            ("titres", ListLayout::Column, 0)
        );
        let r = f.roll.as_ref().unwrap();
        assert_eq!((r.mode, r.dir, r.pause), (RollMode::One, RollDir::Up, 6.0));
        let txt = get(&t, "k-txt");
        // Defaults of the widget of before: Inter, 400, 32 px, white.
        let LayerKind::Text {
            font_family,
            font_weight,
            overflow,
            ..
        } = &txt.kind
        else {
            panic!()
        };
        assert_eq!(
            (font_family.as_str(), *font_weight, *overflow),
            ("Inter", 400, crate::model::TextOverflow::Fit)
        );
        assert_eq!(num_of(txt, Prop::FontSize), 32.0);
        assert_eq!(num_of(txt, Prop::Width), 800.0);
    }

    #[test]
    fn credits_roll_pages_and_crawl_become_list_folders() {
        let credits = |mode: &str, more: Value| {
            let mut l = json!({
                "id": "c", "name": "Générique", "type": "credits", "mode": mode,
                "entries": [
                    { "kind": "section", "a": "Réalisation" },
                    { "kind": "line", "a": "Un film de", "b": "Claire" },
                    { "kind": "logo", "a": "/assets/logo.png" },
                    { "kind": "space", "a": "dot" },
                    { "kind": "qr", "a": "https://example.com" }
                ],
                "props": { "x": 400.0, "y": 40.0, "width": 1100.0, "height": 1000.0 }
            });
            l.as_object_mut()
                .unwrap()
                .extend(more.as_object().unwrap().clone());
            read(json!([l]))
        };
        // A roll over its duration, faded, with the styles of before.
        let t = credits("roll", json!({ "duration": 25.0 }));
        assert_eq!(
            ids(&t),
            ["c", "c-sec", "c-role", "c-name", "c-logo", "c-space"]
        );
        let f = get(&t, "c");
        let list = f.list.as_ref().unwrap();
        assert_eq!(
            (list.layout, list.gap, list.rows.len()),
            (ListLayout::Column, 10.0, 5)
        );
        assert_eq!(list.rows[0]["type"], "section");
        assert_eq!(list.rows[1]["b"], "Claire");
        assert_eq!(list.rows[4]["type"], "qr");
        let r = f.roll.as_ref().unwrap();
        assert_eq!(
            (r.mode, r.dir, r.by, r.duration, r.fade),
            (
                RollMode::Continuous,
                RollDir::Up,
                RollBy::Duration,
                25.0,
                120.0
            )
        );
        let sec = get(&t, "c-sec");
        assert_eq!(num_of(sec, Prop::FontSize), 30.0);
        assert_eq!(
            sec.in_list
                .as_ref()
                .unwrap()
                .when
                .as_ref()
                .unwrap()
                .value
                .as_deref(),
            Some("section")
        );
        // Role | name around the gutter: (1100 − 40) / 2 = 530.
        let (role, name) = (get(&t, "c-role"), get(&t, "c-name"));
        assert_eq!(
            (num_of(role, Prop::Width), num_of(name, Prop::X)),
            (530.0, 570.0)
        );
        assert_eq!(num_of(name, Prop::Height), 57.0);
        assert_eq!(body(name), "{{b}}");
        let logo = get(&t, "c-logo");
        assert!(matches!(&logo.kind, LayerKind::Image { src, .. } if src == "{{a}}"));
        assert_eq!(num_of(logo, Prop::Height), 130.0);
        // By pages: a grid of one column, a page at a time.
        let t = credits("pages", json!({ "cardDur": 3.0, "lineGap": 20.0 }));
        let f = get(&t, "c");
        let list = f.list.as_ref().unwrap();
        assert_eq!(
            (list.layout, list.cols, list.gap),
            (ListLayout::Grid, Some(1), 20.0)
        );
        let r = f.roll.as_ref().unwrap();
        assert_eq!((r.mode, r.pause, r.fade), (RollMode::One, 3.0, 0.0));
        // A crawl at its speed, not faded.
        let t = credits("crawl", json!({ "pxs": 90.0, "fade": false }));
        let f = get(&t, "c");
        assert_eq!(f.list.as_ref().unwrap().layout, ListLayout::Row);
        let r = f.roll.as_ref().unwrap();
        assert_eq!(
            (r.mode, r.dir, r.speed, r.fade),
            (RollMode::Continuous, RollDir::Left, 90.0, 0.0)
        );
    }

    #[test]
    fn scrolling_texts_and_rolls_become_list_folders() {
        let t = read(json!([
            {
                "id": "h", "name": "h", "type": "text", "text": "One\nTwo", "fontFamily": "Oswald",
                "transform": "upper", "scroll": "horizontal", "speed": 90.0, "separator": " | ",
                "props": { "width": 1000.0, "height": 50.0 }
            },
            {
                "id": "v", "name": "v", "type": "text", "text": "Directed by | Jane\n\n# Thanks\nAll",
                "fontFamily": "Oswald", "scroll": "vertical", "speed": 90.0
            },
            { "id": "r", "name": "r", "type": "roll", "text": "A\nB", "fontFamily": "Inter" },
            { "id": "f", "name": "f", "type": "text", "text": "Fixed", "fontFamily": "Inter", "scroll": "none" }
        ]));
        assert_eq!(
            ids(&t),
            [
                "h", "h-sep", "h-txt", "v", "v-sec", "v-role", "v-name", "v-logo", "v-space", "r",
                "r-sec", "r-role", "r-name", "r-logo", "r-space", "f"
            ]
        );
        // Horizontal: its lines going left, after its separator, in its font.
        let h = get(&t, "h");
        let list = h.list.as_ref().unwrap();
        assert_eq!(list.rows.len(), 2);
        assert_eq!(list.rows[1]["texte"], "Two");
        assert_eq!(h.roll.as_ref().unwrap().speed, 90.0);
        assert_eq!(body(get(&t, "h-sep")), "|");
        let LayerKind::Text {
            font_family,
            uppercase,
            ..
        } = &get(&t, "h-txt").kind
        else {
            panic!()
        };
        assert_eq!((font_family.as_str(), *uppercase), ("Oswald", true));
        // Vertical: its lines as credits going up at its speed.
        let v = get(&t, "v");
        let rows = &v.list.as_ref().unwrap().rows;
        let kinds: Vec<&str> = rows.iter().map(|r| r["type"].as_str()).collect();
        assert_eq!(kinds, ["line", "space", "section", "line"]);
        assert_eq!(
            (rows[0]["a"].as_str(), rows[0]["b"].as_str()),
            ("Directed by", "Jane")
        );
        let r = v.roll.as_ref().unwrap();
        assert_eq!((r.by, r.speed, r.fade), (RollBy::Speed, 90.0, 120.0));
        // A roll at its speed (60 px/s by default).
        assert_eq!(get(&t, "r").roll.as_ref().unwrap().speed, 60.0);
        assert!(matches!(get(&t, "f").kind, LayerKind::Text { .. }));
    }

    #[test]
    fn a_project_with_widgets_of_before_reads_converted_and_round_trips() {
        let mut p = crate::sample::demo_project();
        let mut t = p.templates[0].clone();
        let mut raw = serde_json::to_value(&t).unwrap();
        raw["layers"].as_array_mut().unwrap().push(json!({
            "id": "old", "name": "Old", "type": "ticker", "text": "A\nB",
            "props": { "width": 600.0, "height": 40.0 }
        }));
        t = serde_json::from_value(raw).unwrap();
        assert!(t.layers.iter().any(|l| l.id == "old-txt"));
        p.templates[0] = t.clone();
        p.drafts.push(t);
        let json = serde_json::to_string(&p).unwrap();
        let back: crate::model::Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn a_widget_of_the_builder_made_with_them_reads_converted() {
        let d: crate::built::Def = serde_json::from_value(json!({
            "id": "w", "name": "W", "width": 600,
            "layers": [{ "id": "k", "name": "K", "type": "ticker", "text": "A", "props": {} }]
        }))
        .unwrap();
        let ids: Vec<&str> = d.rest["layers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["k", "k-sep", "k-txt"]);
        assert_eq!(d.rest["width"], json!(600));
    }

    #[test]
    fn numbers_and_colours_are_written_as_a_script_writes_them() {
        assert_eq!(n(28.0), json!(28));
        assert_eq!(n(0.5), json!(0.5));
        assert_eq!(num32(&json!(26.123456789), 0.0), 26.123457);
        assert_eq!(
            color("#ff000080", json!(0)),
            json!([1, 0, 0, 128.0 / 255.0])
        );
        assert_eq!(color(" 00FF00 ", json!(0)), json!([0, 1, 0, 1]));
        assert_eq!(color("red", json!("x")), json!("x"));
    }
}
