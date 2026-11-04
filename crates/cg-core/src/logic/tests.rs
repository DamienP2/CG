use super::flow::{self, Act, Tick};
use super::*;

fn node(id: &str, kind: NodeKind) -> Node {
    Node {
        id: id.into(),
        kind,
        x: 0.0,
        y: 0.0,
        frame: None,
        title: None,
    }
}
fn edge(from: &str, to: &str, port: &str) -> Edge {
    Edge {
        from: from.into(),
        from_port: "out".into(),
        to: to.into(),
        port: port.into(),
    }
}
fn edge2(from: &str, from_port: &str, to: &str, port: &str) -> Edge {
    Edge {
        from: from.into(),
        from_port: from_port.into(),
        to: to.into(),
        port: port.into(),
    }
}
fn layer(id: &str, layer: &str, keys: &[&str]) -> Node {
    node(
        id,
        NodeKind::Layer {
            layer: layer.into(),
            rows: keys
                .iter()
                .map(|k| LayerRow {
                    key: (*k).into(),
                    mode: TargetMode::Set,
                })
                .collect(),
        },
    )
}
fn calc(id: &str, e: &str, inputs: &[&str]) -> Node {
    node(
        id,
        NodeKind::Expr {
            expr: e.into(),
            inputs: inputs.iter().map(|s| s.to_string()).collect(),
        },
    )
}
const CLOCK: Clock = Clock {
    secs: 0.0,
    now_ms: 0,
};

#[test]
fn an_older_graph_is_made_over_and_gives_the_same_result() {
    // plate.width = max(text width + 2 × 30, 200); hidden when the name is empty.
    let mut logic = Logic {
        nodes: vec![
            node(
                "tw",
                NodeKind::TextSize {
                    layer: "name".into(),
                    metric: TextMetric::Width,
                },
            ),
            node("pad", NodeKind::Constant { value: 60.0 }),
            node("sum", NodeKind::Math { op: MathOp::Add }),
            node("min", NodeKind::Constant { value: 200.0 }),
            node("max", NodeKind::Math { op: MathOp::Max }),
            node(
                "w",
                NodeKind::Target {
                    layer: "plate".into(),
                    prop: Prop::Width,
                    mode: TargetMode::Set,
                },
            ),
            // x of a second element follows the plate's right edge.
            node(
                "pw",
                NodeKind::LayerProp {
                    layer: "plate".into(),
                    prop: Prop::Width,
                },
            ),
            node(
                "x",
                NodeKind::Target {
                    layer: "logo".into(),
                    prop: Prop::X,
                    mode: TargetMode::Set,
                },
            ),
            node("f", NodeKind::Field { key: "name".into() }),
            node("one", NodeKind::Constant { value: 1.0 }),
            node("zero", NodeKind::Constant { value: 0.0 }),
            node("if", NodeKind::Condition { cmp: Cmp::Empty }),
            node(
                "op",
                NodeKind::Target {
                    layer: "plate".into(),
                    prop: Prop::Opacity,
                    mode: TargetMode::Multiply,
                },
            ),
            node(
                "lim",
                NodeKind::Clamp {
                    min: 0.0,
                    max: 2000.0,
                },
            ),
            node("air", NodeKind::Out {}),
        ],
        edges: vec![
            // Declared before its source on purpose: order comes from the graph.
            edge("pw", "x", "in"),
            edge("tw", "sum", "a"),
            edge("pad", "sum", "b"),
            edge("sum", "max", "a"),
            edge("min", "max", "b"),
            edge("max", "lim", "in"),
            edge("lim", "w", "in"),
            edge("f", "if", "a"),
            edge("zero", "if", "then"),
            edge("one", "if", "else"),
            edge("if", "op", "in"),
            edge("if", "air", "when"),
        ],
        frames: vec![],
    };
    assert!(upgrade(&mut logic));
    assert!(!upgrade(&mut logic));
    assert!(logic.nodes.iter().all(|n| !matches!(
        n.kind,
        NodeKind::Math { .. } | NodeKind::Target { .. } | NodeKind::Condition { .. }
    )));
    assert!(logic.edges.iter().any(|e| e.to == "air" && e.port == "run"));
    assert!(logic
        .edges
        .iter()
        .any(|e| e.from == "tw" && e.from_port == "text.width"));
    logic.nodes.rotate_left(6); // targets in any order
    let run = |name: &str| {
        let mut values: Values = HashMap::new();
        for l in ["name", "plate", "logo"] {
            values.insert(
                l.into(),
                [
                    (Prop::Width, Value::Number(100.0)),
                    (Prop::Opacity, Value::Number(1.0)),
                ]
                .into(),
            );
        }
        let mut data = Data::new();
        data.insert("name".into(), name.into());
        let len = name.chars().count() as f64;
        apply(&logic, &mut values, &data, &mut |_, _, _| len * 20.0, CLOCK);
        values
    };
    let v = run("Ada Lovelace"); // 12 chars -> 240 px
    assert_eq!(v["plate"][&Prop::Width], Value::Number(300.0));
    assert_eq!(v["logo"][&Prop::X], Value::Number(300.0));
    assert_eq!(v["plate"][&Prop::Opacity], Value::Number(1.0));
    let v = run("Al"); // 40 + 60 < 200
    assert_eq!(v["plate"][&Prop::Width], Value::Number(200.0));
    let v = run("");
    assert_eq!(v["plate"][&Prop::Opacity], Value::Number(0.0));
    assert_eq!(targeted(&logic), ["plate", "logo"].into_iter().collect());
}

#[test]
fn moves_up_while_another_graphic_is_on_air() {
    // y + presence(ticker) × −120
    let logic = Logic {
        nodes: vec![
            node(
                "air",
                NodeKind::OnAir {
                    template: "ticker".into(),
                    transition: 0.4,
                    test: false,
                },
            ),
            calc("mul", "a * -120", &["a"]),
            node(
                "y",
                NodeKind::Layer {
                    layer: "plate".into(),
                    rows: vec![LayerRow {
                        key: "y".into(),
                        mode: TargetMode::Add,
                    }],
                },
            ),
        ],
        edges: vec![edge("air", "mul", "a"), edge("mul", "y", "y")],
        frames: vec![],
    };
    assert_eq!(on_air_watched(&logic), vec![("ticker", 0.4)]);
    let run = |data: &Data| {
        let mut values: Values = HashMap::new();
        values.insert("plate".into(), [(Prop::Y, Value::Number(900.0))].into());
        apply(&logic, &mut values, data, &mut |_, _, _| 0.0, CLOCK);
        values["plate"][&Prop::Y]
    };
    let mut d = Data::new();
    assert_eq!(run(&d), Value::Number(900.0));
    d.insert(on_air_key("ticker"), "0.5000".into());
    assert_eq!(run(&d), Value::Number(840.0));
    d.insert(on_air_key("ticker"), "1".into());
    assert_eq!(run(&d), Value::Number(780.0));
}

#[test]
fn if_else_if_else_chooses_a_colour() {
    let logic = Logic {
        nodes: vec![
            node("a", NodeKind::Field { key: "home".into() }),
            node("b", NodeKind::Field { key: "away".into() }),
            node(
                "if",
                NodeKind::If {
                    inputs: ab(),
                    branches: vec![
                        Branch {
                            when: "a > b".into(),
                            value: "\"#16a34a\"".into(),
                        },
                        Branch {
                            when: "a < b".into(),
                            value: "\"#dc2626\"".into(),
                        },
                    ],
                    otherwise: "\"#64748b\"".into(),
                },
            ),
            layer("bg", "bg", &["fill"]),
        ],
        edges: vec![
            edge("a", "if", "a"),
            edge("b", "if", "b"),
            edge("if", "bg", "fill"),
        ],
        frames: vec![],
    };
    let run = |h: &str, a: &str| {
        let mut values: Values = HashMap::new();
        values.insert("bg".into(), BTreeMap::new());
        let mut d = Data::new();
        d.insert("home".into(), h.into());
        d.insert("away".into(), a.into());
        apply(&logic, &mut values, &d, &mut |_, _, _| 0.0, CLOCK);
        match &values["bg"][&Prop::Fill] {
            Value::Color(c) => c.to_hex(),
            v => panic!("{v:?}"),
        }
    };
    assert_eq!(run("3", "1"), "#16a34a");
    assert_eq!(run("1", "2"), "#dc2626");
    assert_eq!(run("2", "2"), "#64748b");
}

#[test]
fn a_frame_switched_off_does_not_act() {
    let mut logic = Logic {
        nodes: vec![
            node("k", NodeKind::Constant { value: 42.0 }),
            layer("w", "plate", &["width"]),
        ],
        edges: vec![edge("k", "w", "width")],
        frames: vec![Frame {
            id: "f".into(),
            off: true,
            ..Default::default()
        }],
    };
    logic.nodes[1].frame = Some("f".into());
    let mut values: Values = HashMap::new();
    values.insert("plate".into(), [(Prop::Width, Value::Number(1.0))].into());
    apply(&logic, &mut values, &Data::new(), &mut |_, _, _| 0.0, CLOCK);
    assert_eq!(values["plate"][&Prop::Width], Value::Number(1.0));
    logic.frames[0].off = false;
    apply(&logic, &mut values, &Data::new(), &mut |_, _, _| 0.0, CLOCK);
    assert_eq!(values["plate"][&Prop::Width], Value::Number(42.0));
}

#[test]
fn a_calculation_shown_in_a_text_and_a_content_set() {
    let mut t: crate::model::Template = serde_json::from_str(
        r#"{"id":"t","name":"T","duration":50,"layers":[{"id":"name","name":"Nom","type":"text","text":"Ada","fontFamily":"Inter"}]}"#,
    )
    .unwrap();
    let mut d = Data::new();
    d.insert("score".into(), "12".into());
    assert!(with_outputs(&t, 0.0, &d, CLOCK).is_none());
    assert!(patched(&t, 0.0, &d, CLOCK).is_none());
    t.logic = Logic {
        nodes: vec![
            node(
                "f",
                NodeKind::Field {
                    key: "score".into(),
                },
            ),
            calc("m", "a * 2.5", &["a"]),
            node(
                "out",
                NodeKind::SetField {
                    key: "calc_m".into(),
                },
            ),
            calc("p", "pluriel(a, \"point\", \"points\")", &["a"]),
            calc("j", "a & \" \" & b", &["a", "b"]),
            layer("l", "name", &["content.text"]),
        ],
        edges: vec![
            edge("f", "m", "a"),
            edge("m", "out", "in"),
            edge("f", "p", "a"),
            edge("f", "j", "a"),
            edge("p", "j", "b"),
            edge("j", "l", "content.text"),
        ],
        frames: vec![],
    };
    assert_eq!(with_outputs(&t, 0.0, &d, CLOCK).unwrap()["calc_m"], "30");
    let p = patched(&t, 0.0, &d, CLOCK).unwrap();
    assert!(serde_json::to_string(&p.layers[0])
        .unwrap()
        .contains("\"12 points\""));
    d.insert("score".into(), "1,1".into());
    assert_eq!(with_outputs(&t, 0.0, &d, CLOCK).unwrap()["calc_m"], "2.75");
    assert_eq!(format_number(1.0 / 3.0), "0.33");
    assert_eq!(format_number(-4.0), "-4");
}

#[test]
fn a_lookup_table() {
    let logic = Logic {
        nodes: vec![
            node("f", NodeKind::Field { key: "team".into() }),
            node(
                "t",
                NodeKind::Lookup {
                    rows: vec![
                        LookupRow {
                            key: "PSG".into(),
                            value: "psg.png".into(),
                        },
                        LookupRow {
                            key: "OM".into(),
                            value: "om.png".into(),
                        },
                    ],
                    otherwise: "ligue.png".into(),
                    contains: false,
                },
            ),
        ],
        edges: vec![edge("f", "t", "in")],
        frames: vec![],
    };
    let mut d = Data::new();
    d.insert("team".into(), " psg ".into());
    assert_eq!(
        flow::value(&logic, "t", "out", &d, 0.0),
        LVal::Text("psg.png".into())
    );
    d.insert("team".into(), "Lens".into());
    assert_eq!(
        flow::value(&logic, "t", "out", &d, 0.0),
        LVal::Text("ligue.png".into())
    );
}

#[test]
fn flows_wait_count_choose_and_act() {
    // Continue → counter → if (counter >= 3: out, else: next row); start → wait 2 s → fire « go ».
    let logic = Logic {
        nodes: vec![
            node("c", NodeKind::Continue {}),
            node(
                "n",
                NodeKind::Counter {
                    start: 0.0,
                    step: 1.0,
                },
            ),
            node(
                "if",
                NodeKind::If {
                    inputs: vec!["a".into()],
                    branches: vec![Branch {
                        when: "a >= 3".into(),
                        value: String::new(),
                    }],
                    otherwise: String::new(),
                },
            ),
            node("out", NodeKind::Out {}),
            node(
                "row",
                NodeKind::NextRow {
                    dataset: "ds".into(),
                },
            ),
            node("s", NodeKind::Start {}),
            node("w", NodeKind::Wait { seconds: 2.0 }),
            node("go", NodeKind::Fire { name: "go".into() }),
        ],
        edges: vec![
            edge2("c", "out", "n", "run"),
            edge2("n", "next", "if", "run"),
            edge2("n", "out", "if", "a"),
            edge2("if", "b0", "out", "run"),
            edge2("if", "else", "row", "run"),
            edge2("s", "out", "w", "run"),
            edge2("w", "next", "go", "run"),
        ],
        frames: vec![],
    };
    let mut watch = BTreeMap::new();
    let mut vals = BTreeMap::new();
    let tick = |secs: f64,
                f2: bool,
                watch: &mut BTreeMap<String, String>,
                vals: &mut BTreeMap<String, String>| {
        let mut d: Data = vals.clone().into_iter().collect();
        d.insert(event_key("c"), if f2 { "1" } else { "0" }.into());
        flow::run(
            &logic,
            &Tick {
                data: &d,
                secs,
                now_ms: 0,
            },
            watch,
            vals,
        )
    };
    assert_eq!(tick(0.0, false, &mut watch, &mut vals), vec![]);
    assert_eq!(
        tick(0.1, true, &mut watch, &mut vals),
        vec![Act::NextRow("ds".into())]
    );
    // Held down: once.
    assert_eq!(tick(0.2, true, &mut watch, &mut vals), vec![]);
    assert_eq!(tick(0.3, false, &mut watch, &mut vals), vec![]);
    assert_eq!(
        tick(0.4, true, &mut watch, &mut vals),
        vec![Act::NextRow("ds".into())]
    );
    assert_eq!(tick(1.0, false, &mut watch, &mut vals), vec![]);
    assert_eq!(
        tick(2.0, false, &mut watch, &mut vals),
        vec![Act::Fire("go".into())]
    );
    assert_eq!(tick(2.1, true, &mut watch, &mut vals), vec![Act::Out(None)]);
    assert_eq!(vals[&count_key("n")], "3");
}

#[test]
fn json_shape() {
    let n: Node = serde_json::from_str(
        r#"{"id":"a","type":"textSize","layer":"t","metric":"height","x":10,"y":20}"#,
    )
    .unwrap();
    assert_eq!(
        n.kind,
        NodeKind::TextSize {
            layer: "t".into(),
            metric: TextMetric::Height
        }
    );
    let e: Edge = serde_json::from_str(r#"{"from":"a","to":"b","port":"in"}"#).unwrap();
    assert_eq!(e.from_port, "out");
    assert_eq!(
        serde_json::to_string(&e).unwrap(),
        r#"{"from":"a","to":"b","port":"in"}"#
    );
    let n: Node = serde_json::from_str(
        r#"{"id":"i","type":"if","branches":[{"when":"a > b","value":"1"}],"frame":"f1"}"#,
    )
    .unwrap();
    assert_eq!(n.frame.as_deref(), Some("f1"));
    assert!(matches!(n.kind, NodeKind::If { ref inputs, .. } if inputs == &["a", "b"]));
}

fn when(id: &str, on: &str) -> Node {
    node(
        id,
        NodeKind::When {
            on: on.into(),
            name: String::new(),
            seconds: 0.0,
            dataset: String::new(),
        },
    )
}

fn check(id: &str, rows: &[(&str, &str, &str)]) -> Node {
    node(
        id,
        NodeKind::Check {
            rows: rows
                .iter()
                .map(|(w, t, v)| CheckRow {
                    what: (*w).into(),
                    test: (*t).into(),
                    value: (*v).into(),
                    join: String::new(),
                })
                .collect(),
            any: false,
        },
    )
}

/// Runs the graph (made over for `scope`) on `data`; the actions asked.
fn step(
    logic: &Logic,
    scope: Scope,
    data: &[(String, &str)],
    watch: &mut BTreeMap<String, String>,
) -> Vec<Act> {
    let g = current_in(logic, scope);
    let d: Data = data.iter().map(|(k, v)| (k.clone(), (*v).into())).collect();
    flow::run(
        &g,
        &Tick {
            data: &d,
            secs: 0.0,
            now_ms: 0,
        },
        watch,
        &mut BTreeMap::new(),
    )
}

#[test]
fn steps_resume_a_playlist_cut_when_a_graphic_goes_out() {
    // Synthé → When it goes out → If Résultats is interrupted → yes: resume Résultats; no: take Logo.
    let logic = Logic {
        nodes: vec![
            node(
                "syn",
                NodeKind::Template {
                    template: "synthe".into(),
                },
            ),
            when("w", "out"),
            check("if", &[("pl:res", "interrupted", "")]),
            node(
                "go",
                NodeKind::ResumePlaylist {
                    playlist: "res".into(),
                },
            ),
            node(
                "logo",
                NodeKind::Take {
                    template: "logo".into(),
                    out: false,
                },
            ),
        ],
        edges: vec![
            edge2("syn", "src", "w", "src"),
            edge2("w", "out", "if", "run"),
            edge2("if", "yes", "go", "run"),
            edge2("if", "no", "logo", "run"),
        ],
        frames: vec![],
    };
    let air = |v: &'static str, cut: &'static str| {
        vec![(on_air_key("synthe"), v), (interrupted_key("res"), cut)]
    };
    let mut w = BTreeMap::new();
    assert!(step(&logic, Scope::Project, &air("1", "1"), &mut w).is_empty());
    assert_eq!(
        step(&logic, Scope::Project, &air("0", "1"), &mut w),
        vec![Act::ResumePlaylist("res".into(), None)]
    );
    // Not interrupted: the other branch.
    let mut w = BTreeMap::new();
    step(&logic, Scope::Project, &air("1", "0"), &mut w);
    assert_eq!(
        step(&logic, Scope::Project, &air("0", "0"), &mut w),
        vec![Act::Take("logo".into(), None)]
    );
}

#[test]
fn steps_in_a_graphic_become_its_events() {
    let logic = Logic {
        nodes: vec![
            layer("l", "roll", &[]),
            when("w", "scrollEnd"),
            when("t", "trigger"),
            node("o", NodeKind::Out {}),
        ],
        edges: vec![
            edge2("l", "src", "w", "src"),
            edge2("w", "out", "o", "run"),
            edge2("t", "out", "o", "run"),
        ],
        frames: vec![],
    };
    let g = current(&logic);
    let kind = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap().kind.clone();
    assert_eq!(
        kind("w"),
        NodeKind::Event {
            on: crate::model::TriggerEvent::ScrollEnd {
                layer: "roll".into(),
                passes: 1
            }
        }
    );
    assert_eq!(
        kind("t"),
        NodeKind::TriggerIn {
            name: String::new()
        }
    );
    // The event seen on air runs the flow.
    let mut w = BTreeMap::new();
    assert!(step(&logic, Scope::Graphic, &[], &mut w).is_empty());
    assert_eq!(
        step(&logic, Scope::Graphic, &[(event_key("w"), "1")], &mut w),
        vec![Act::Out(None)]
    );
}

#[test]
fn steps_watch_a_value_and_compare_it() {
    // Score → When it changes → If score > 50 and the name is not empty → fire « big ».
    let logic = Logic {
        nodes: vec![
            node(
                "s",
                NodeKind::Field {
                    key: "score".into(),
                },
            ),
            when("w", "change"),
            check(
                "if",
                &[("field:score", "gt", "50"), ("field:name", "notEmpty", "")],
            ),
            node("f", NodeKind::Fire { name: "big".into() }),
        ],
        edges: vec![
            edge2("s", "src", "w", "src"),
            edge2("w", "out", "if", "run"),
            edge2("if", "yes", "f", "run"),
        ],
        frames: vec![],
    };
    let d = |score: &'static str, name: &'static str| {
        vec![("score".to_string(), score), ("name".to_string(), name)]
    };
    let mut w = BTreeMap::new();
    assert!(step(&logic, Scope::Graphic, &d("10", "Léa"), &mut w).is_empty());
    assert!(step(&logic, Scope::Graphic, &d("30", "Léa"), &mut w).is_empty());
    assert_eq!(
        step(&logic, Scope::Graphic, &d("60", "Léa"), &mut w),
        vec![Act::Fire("big".into())]
    );
    assert!(step(&logic, Scope::Graphic, &d("60", "Léa"), &mut w).is_empty());
    assert!(step(&logic, Scope::Graphic, &d("70", ""), &mut w).is_empty());
}

#[test]
fn a_how_on_the_way_goes_with_the_action() {
    use crate::playout::{How, HowMode, Side};
    let how = How {
        mode: HowMode::Slide,
        seconds: 0.8,
        easing: crate::easing::Easing::EaseOut,
        side: Side::Right,
    };
    let logic = Logic {
        nodes: vec![
            when("w", "trigger"),
            node(
                "h",
                NodeKind::How {
                    mode: how.mode,
                    seconds: how.seconds,
                    easing: how.easing,
                    side: how.side,
                },
            ),
            node(
                "t",
                NodeKind::Take {
                    template: "logo".into(),
                    out: false,
                },
            ),
            node("o", NodeKind::Out {}),
        ],
        edges: vec![
            edge2("w", "out", "h", "run"),
            edge2("h", "next", "t", "run"),
            edge2("w", "out", "o", "run"),
        ],
        frames: vec![],
    };
    let mut w = BTreeMap::new();
    step(&logic, Scope::Graphic, &[], &mut w);
    let acts = step(&logic, Scope::Graphic, &[(event_key("w"), "1")], &mut w);
    // The take goes that way; the out, not after the How…, its own way.
    assert!(acts.contains(&Act::Take("logo".into(), Some(how))));
    assert!(acts.contains(&Act::Out(None)));
}

#[test]
fn and_binds_before_or() {
    // (a > 5 and b > 5) or c > 5
    let mut c = check(
        "if",
        &[
            ("field:a", "gt", "5"),
            ("field:b", "gt", "5"),
            ("field:c", "gt", "5"),
        ],
    );
    if let NodeKind::Check { rows, .. } = &mut c.kind {
        rows[2].join = "or".into();
    }
    let logic = Logic {
        nodes: vec![c],
        edges: vec![],
        frames: vec![],
    };
    let g = current(&logic);
    let holds = |a: &str, b: &str, cc: &str| {
        let d: Data = [("a", a), ("b", b), ("c", cc)]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        flow::value(&g, "if", "out", &d, 0.0) == LVal::Num(1.0)
    };
    assert!(holds("9", "9", "0"));
    assert!(!holds("9", "0", "0"));
    assert!(holds("0", "0", "9"));
}
