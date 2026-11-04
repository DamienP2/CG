//! The Logic canvas: a node graph per template.
//!
//! Every node has named inputs (left) and outputs (right). Two kinds of
//! wires: values, evaluated on every frame by the renderers after
//! animation and data bindings (a plate whose width follows a name, a
//! colour chosen by a score), and flows ▶ (« when… then… »), run on air
//! by the server in order (an event, wait 8 s, take out). See [`flow`].
//!
//! The web renderer mirrors this module (`web/src/engine/logic.ts`,
//! `web/src/engine/expr.ts`).

pub mod expr;
pub mod flow;

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::anim::Data;
use crate::model::{Color, Prop, Value};
pub use expr::Clock;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Logic {
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    /// Dashed frames gathering the nodes of one function.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<Frame>,
}

impl Logic {
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.frames.is_empty()
    }
}

/// A function of the graph: a named, coloured frame its nodes are in.
/// Switched off, its nodes no longer act (they still compute values).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub off: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub collapsed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    #[serde(flatten)]
    pub kind: NodeKind,
    /// Position in the editor canvas.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// The frame (function) it is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    /// A name given in the editor (« Formater un nombre »…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextMetric {
    /// Width of the longest line, in the layer's pixels.
    #[default]
    Width,
    Height,
    Lines,
    Chars,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MathOp {
    Add,
    Sub,
    Mul,
    Div,
    Min,
    Max,
    Abs,
    Round,
    Floor,
    Ceil,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cmp {
    Gt,
    Ge,
    Lt,
    Le,
    Eq,
    Ne,
    Empty,
    NotEmpty,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetMode {
    #[default]
    Set,
    Add,
    Multiply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoolOp {
    And,
    Or,
}

/// A row of a Layer node: a property (`width`, `fill`…), a measure of its
/// text (`text.width`, `text.height`, `text.lines`, `text.chars`) or its
/// content (`content.text`, `content.src`…). Its port, on both sides, is
/// its key: read on the right, set on the left (`mode` for a number).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerRow {
    pub key: String,
    #[serde(default, skip_serializing_if = "is_set")]
    pub mode: TargetMode,
}

fn is_set(m: &TargetMode) -> bool {
    *m == TargetMode::Set
}

/// A branch of an If: its condition and its value (expressions).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    #[serde(default)]
    pub when: String,
    #[serde(default)]
    pub value: String,
}

/// A row of a Lookup table: `key` → `value`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupRow {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
}

/// A line of an If… phrase: `what` (`tpl:<id>`, `pl:<id>`, `field:<key>`,
/// `var:<name>`, or `in`: the value wired into input `in`), its `test`
/// (`onAir`, `notOnAir`, `interrupted`, `notInterrupted`, `ended`,
/// `notEnded`, `yes`, `no`, `gt`, `ge`, `lt`, `le`, `eq`, `ne`, `contains`,
/// `empty`, `notEmpty`) and the `value` it is compared with.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRow {
    #[serde(default)]
    pub what: String,
    #[serde(default)]
    pub test: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    /// How it joins the line before: `and` (the default) or `or`; the lines
    /// joined by « and » go together, « or » separates them.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub join: String,
}

fn is_zero(x: &f64) -> bool {
    *x == 0.0
}

fn ab() -> Vec<String> {
    vec!["a".into(), "b".into()]
}
fn one() -> f64 {
    1.0
}
fn half() -> f64 {
    0.5
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NodeKind {
    // ── Values ─────────────────────────────────────────────────────────
    /// A layer: the rows chosen (see [`LayerRow`]).
    Layer {
        layer: String,
        #[serde(default)]
        rows: Vec<LayerRow>,
    },
    /// A data field (number, or text).
    Field {
        key: String,
    },
    Constant {
        value: f64,
    },
    Text {
        #[serde(default)]
        value: String,
    },
    /// A colour (`#rrggbb` or `#rrggbbaa`).
    Color {
        #[serde(default)]
        value: String,
    },
    /// Yes / no (1 / 0).
    Flag {
        #[serde(default)]
        value: bool,
    },
    /// A Calculation: `expr` over the inputs named `inputs` (output `out`).
    Expr {
        #[serde(default)]
        expr: String,
        #[serde(default = "ab")]
        inputs: Vec<String>,
    },
    /// If / else if / else: the value of the first branch whose condition
    /// holds (output `out`); its flow output (`b0`, `b1`… `else`) goes
    /// when the branch is chosen, or each time `run` comes in.
    If {
        #[serde(default = "ab")]
        inputs: Vec<String>,
        #[serde(default)]
        branches: Vec<Branch>,
        #[serde(default)]
        otherwise: String,
    },
    /// A table: the value of the row whose key is input `in` (any case;
    /// `contains`: the key is found in it), else `otherwise`.
    Lookup {
        #[serde(default)]
        rows: Vec<LookupRow>,
        #[serde(default)]
        otherwise: String,
        #[serde(default)]
        contains: bool,
    },
    /// 1 while the graphic `template` is on air, 0 otherwise, gliding over
    /// `transition` seconds as it comes in and goes out. On air the
    /// renderers put its presence in the data ([`on_air_key`]); elsewhere
    /// (the Designer) it is `test`.
    OnAir {
        template: String,
        #[serde(default)]
        transition: f64,
        #[serde(default)]
        test: bool,
    },
    /// The variable `name` (0 until set on air; `test` in the Designer).
    Var {
        name: String,
        #[serde(default)]
        test: f64,
    },
    /// Writes input `in` into the data value `key`: a text showing `{{key}}`
    /// shows the result of a calculation (see [`with_outputs`]).
    SetField {
        key: String,
    },

    // ── The project's Logic (see [`crate::playout::ChannelState::run_project`]) ──
    /// A graphic of the project: flows `in` (it goes on air) and `out` (it
    /// has gone out), value `onAir` (1 while on air).
    Template {
        template: String,
    },
    /// A playlist: flows `taken` (a row of it is taken) and `end` (its last
    /// row has gone out); values `onAir` (a row of it on air) and
    /// `interrupted` (its graphic replaced by another playlist's, not played on since).
    Playlist {
        playlist: String,
    },

    // ── Steps: Source → When → If → actions ────────────────────────────
    /// When…: a moment `on` of its source (input `src`: a graphic, a
    /// playlist, a layer, a data field, a variable), or with no source of
    /// the graphic or the channel (`start`, `continue`, `trigger` `name`,
    /// `every` `seconds`, `lastRow` of `dataset`). Flow output `out`. Made
    /// into the nodes below by [`current`].
    When {
        #[serde(default)]
        on: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        name: String,
        #[serde(default, skip_serializing_if = "is_zero")]
        seconds: f64,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        dataset: String,
    },
    /// If…: the phrase `rows` holds (all of them, or one when `any`): flow
    /// `yes`, else `no` (each time `run` comes in, or when it changes);
    /// value `out` (1 / 0). Made into an If by [`current`].
    Check {
        #[serde(default)]
        rows: Vec<CheckRow>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        any: bool,
    },

    // ── Flows: what starts them (output `out`) ─────────────────────────
    /// The event has happened on air (watched by the server).
    Event {
        on: crate::model::TriggerEvent,
    },
    /// The trigger `name` is received (API, Companion, a button of the Operator).
    TriggerIn {
        name: String,
    },
    /// Continue (F2) is pressed for the graphic.
    Continue {},
    /// The graphic is taken.
    Start {},
    /// Every `seconds` while on air.
    Every {
        #[serde(default = "one")]
        seconds: f64,
    },

    /// How…: the take, out, resume or clear after it goes this way (cut,
    /// fade, slide through an edge, or the graphic's own animation), over
    /// `seconds` on `easing` (input `run`, output `next`).
    How {
        #[serde(default)]
        mode: crate::playout::HowMode,
        #[serde(default = "half")]
        seconds: f64,
        #[serde(default)]
        easing: crate::easing::Easing,
        #[serde(default)]
        side: crate::playout::Side,
    },

    // ── Flows: on the way (input `run`, output `next`) ─────────────────
    /// Waits `seconds` (or input `seconds`), then `next`.
    Wait {
        #[serde(default = "one")]
        seconds: f64,
    },
    /// Counts the `run`s (output `out`): `start`, + `step` each time;
    /// `reset` starts again.
    Counter {
        #[serde(default)]
        start: f64,
        #[serde(default = "one")]
        step: f64,
    },
    /// Lets the first `run` through, until `reset`.
    Once {},

    // ── Actions (input `run`, output `next`) ───────────────────────────
    /// The graphic goes out (once its in animation is over).
    Out {},
    /// The pause `marker` plays on.
    Resume {
        marker: String,
    },
    /// Fires the trigger `name` (as the API or Companion).
    Fire {
        name: String,
    },
    /// The data set `dataset` shows its next row.
    NextRow {
        dataset: String,
    },
    /// Sets the variable `name` to `value` (or input `value`); a number
    /// glides there over `transition` seconds.
    SetVar {
        name: String,
        #[serde(default)]
        value: String,
        #[serde(default)]
        transition: f64,
    },
    /// Takes the graphic `template` (`out`: takes it out).
    Take {
        template: String,
        #[serde(default)]
        out: bool,
    },
    /// Plays the playlist `playlist` on: the row after the last one taken
    /// (the first when none was), on the playlist's outputs; its Auto next
    /// goes on from there.
    ResumePlaylist {
        playlist: String,
    },
    /// The Auto next of the playlist `playlist` stops: its graphic on air
    /// stays until taken out.
    StopAuto {
        playlist: String,
    },
    /// Takes everything out (as « Clear all »).
    ClearAll {},
    /// Changes properties of the layer `layer` (of the graphic `template`
    /// in the project's Logic): to a value, by an offset, or back to the
    /// animation's, over the length and curve of the How… before it.
    Animate {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        template: String,
        #[serde(default)]
        layer: String,
        #[serde(default)]
        sets: Vec<crate::playout::PropSet>,
    },
    /// Starts, pauses, resets… a widget of the graphic (`control`: start,
    /// pause, toggle, reset, restart).
    Widget {
        layer: String,
        control: String,
    },

    // ── Older graphs, made over by [`upgrade`] when a template loads ───
    LayerProp {
        layer: String,
        prop: Prop,
    },
    TextSize {
        layer: String,
        #[serde(default)]
        metric: TextMetric,
    },
    Math {
        op: MathOp,
    },
    Clamp {
        min: f64,
        max: f64,
    },
    Condition {
        cmp: Cmp,
    },
    Target {
        layer: String,
        prop: Prop,
        #[serde(default)]
        mode: TargetMode,
    },
    Bool {
        op: BoolOp,
    },
}

impl NodeKind {
    /// Its flow outputs.
    pub fn flow_outputs(&self) -> Vec<String> {
        match self {
            NodeKind::Event { .. }
            | NodeKind::TriggerIn { .. }
            | NodeKind::Continue {}
            | NodeKind::Start {}
            | NodeKind::Every { .. }
            | NodeKind::When { .. } => vec!["out".into()],
            NodeKind::Check { .. } => vec!["yes".into(), "no".into()],
            NodeKind::Template { .. } => vec!["in".into(), "out".into()],
            NodeKind::Playlist { .. } => vec!["taken".into(), "end".into(), "interrupted".into()],
            NodeKind::If { branches, .. } => (0..branches.len())
                .map(|i| format!("b{i}"))
                .chain(["else".to_string()])
                .collect(),
            k if k.takes_flow() => vec!["next".into()],
            _ => Vec::new(),
        }
    }
    /// Its flow inputs.
    pub fn flow_inputs(&self) -> &'static [&'static str] {
        match self {
            NodeKind::If { .. } | NodeKind::Check { .. } => &["run"],
            NodeKind::Counter { .. } | NodeKind::Once {} => &["run", "reset"],
            k if k.takes_flow() => &["run"],
            _ => &[],
        }
    }
    fn takes_flow(&self) -> bool {
        matches!(
            self,
            NodeKind::Wait { .. }
                | NodeKind::How { .. }
                | NodeKind::Counter { .. }
                | NodeKind::Once {}
                | NodeKind::Out {}
                | NodeKind::Resume { .. }
                | NodeKind::Fire { .. }
                | NodeKind::NextRow { .. }
                | NodeKind::SetVar { .. }
                | NodeKind::Take { .. }
                | NodeKind::ResumePlaylist { .. }
                | NodeKind::StopAuto { .. }
                | NodeKind::ClearAll {}
                | NodeKind::Animate { .. }
                | NodeKind::Widget { .. }
        )
    }
}

/// The data key of what an event, trigger or Continue node saw on air (`1`
/// or `0`), set by the server for the renderers.
pub fn event_key(node: &str) -> String {
    format!("__ev_{node}")
}

/// The data key of a variable.
pub fn var_key(name: &str) -> String {
    format!("__var_{}", name.trim())
}

/// The data key of a Counter's value.
pub fn count_key(node: &str) -> String {
    format!("__cnt_{node}")
}

/// `a` and `b` as one graph (the Logic and the Triggers of older templates).
pub fn merged(a: &Logic, b: &Logic) -> Logic {
    let mut out = a.clone();
    out.nodes.extend(b.nodes.iter().cloned());
    out.edges.extend(b.edges.iter().cloned());
    out.frames.extend(b.frames.iter().cloned());
    out
}

fn out_port() -> String {
    "out".into()
}
fn is_out(p: &String) -> bool {
    p == "out"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: String,
    /// Output of `from` (`out`, a Layer row, an If branch…).
    #[serde(default = "out_port", skip_serializing_if = "is_out")]
    pub from_port: String,
    pub to: String,
    /// Input of `to`.
    pub port: String,
}

/// A value flowing through the graph.
#[derive(Debug, Clone, PartialEq)]
pub enum LVal {
    Num(f64),
    Text(String),
}

impl LVal {
    pub fn num(&self) -> f64 {
        match self {
            LVal::Num(n) => *n,
            LVal::Text(t) => t.trim().replace(',', ".").parse().unwrap_or(0.0),
        }
    }
}

/// Resolved property values by layer id; updated in place by the targets.
pub type Values = HashMap<String, BTreeMap<Prop, Value>>;

/// Text measurement: (layer id, its current values) -> metric value.
pub type Measure<'a> = dyn FnMut(&str, &BTreeMap<Prop, Value>, TextMetric) -> f64 + 'a;

/// A property by its name (`width`, `fill`…).
pub fn prop_of(key: &str) -> Option<Prop> {
    serde_json::from_value(serde_json::Value::String(key.into())).ok()
}

/// The name of a property.
pub fn prop_key(p: Prop) -> String {
    match serde_json::to_value(p) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

fn metric_of(key: &str) -> Option<TextMetric> {
    match key {
        "text.width" => Some(TextMetric::Width),
        "text.height" => Some(TextMetric::Height),
        "text.lines" => Some(TextMetric::Lines),
        "text.chars" => Some(TextMetric::Chars),
        _ => None,
    }
}

pub(crate) struct Graph<'a> {
    pub nodes: HashMap<&'a str, &'a Node>,
    /// (to, port) → (from, from port).
    pub inputs: HashMap<(&'a str, &'a str), (&'a str, &'a str)>,
    /// Nodes in a frame switched off: they do not act.
    pub off: HashSet<&'a str>,
}

impl<'a> Graph<'a> {
    pub fn new(logic: &'a Logic) -> Self {
        let off_frames: HashSet<&str> = logic
            .frames
            .iter()
            .filter(|f| f.off)
            .map(|f| f.id.as_str())
            .collect();
        Self {
            nodes: logic.nodes.iter().map(|n| (n.id.as_str(), n)).collect(),
            inputs: logic
                .edges
                .iter()
                .map(|e| {
                    (
                        (e.to.as_str(), e.port.as_str()),
                        (e.from.as_str(), e.from_port.as_str()),
                    )
                })
                .collect(),
            off: logic
                .nodes
                .iter()
                .filter(|n| n.frame.as_deref().is_some_and(|f| off_frames.contains(f)))
                .map(|n| n.id.as_str())
                .collect(),
        }
    }

    pub fn acts(&self, id: &str) -> bool {
        !self.off.contains(id)
    }

    /// Layers (and properties; None: all of them) a node's input reads, upstream.
    fn reads(
        &self,
        id: &str,
        port: &str,
        seen: &mut HashSet<String>,
        out: &mut HashSet<(String, Option<Prop>)>,
    ) {
        let Some(&(from, from_port)) = self.inputs.get(&(id, port)) else {
            return;
        };
        if !seen.insert(format!("{from}|{from_port}")) {
            return;
        }
        let Some(n) = self.nodes.get(from) else {
            return;
        };
        match &n.kind {
            NodeKind::Layer { layer, .. } => {
                let prop = if metric_of(from_port).is_some() {
                    None
                } else {
                    prop_of(from_port)
                };
                out.insert((layer.clone(), prop));
            }
            k => {
                for p in input_ports(k) {
                    self.reads(from, &p, seen, out);
                }
            }
        }
    }

    /// The value of input `port` of node `id` (None: not wired).
    pub fn input(&self, id: &str, port: &str, cx: &mut Cx, depth: usize) -> Option<LVal> {
        let &(from, from_port) = self.inputs.get(&(id, port))?;
        Some(self.eval(from, from_port, cx, depth + 1))
    }

    /// The value of output `port` of node `id`.
    pub fn eval(&self, id: &str, port: &str, cx: &mut Cx, depth: usize) -> LVal {
        let Some(n) = self.nodes.get(id) else {
            return LVal::Num(0.0);
        };
        if depth > 96 {
            return LVal::Num(0.0);
        }
        let empty = || LVal::Text(String::new());
        match &n.kind {
            NodeKind::Layer { layer, .. } => {
                let vals = cx.values;
                let Some(v) = vals.get(layer) else {
                    return LVal::Num(0.0);
                };
                if let Some(m) = metric_of(port) {
                    return LVal::Num((cx.measure)(layer, v, m));
                }
                match prop_of(port).and_then(|p| v.get(&p)) {
                    Some(Value::Number(x)) => LVal::Num(*x),
                    Some(Value::Color(c)) => LVal::Text(c.to_hex()),
                    _ => LVal::Num(0.0),
                }
            }
            NodeKind::Field { key } => LVal::Text(cx.data.get(key).cloned().unwrap_or_default()),
            NodeKind::Constant { value } => LVal::Num(*value),
            NodeKind::Text { value } | NodeKind::Color { value } => LVal::Text(value.clone()),
            NodeKind::Flag { value } => LVal::Num(*value as u8 as f64),
            NodeKind::Expr { expr, .. } => {
                let clock = cx.clock;
                expr::run(
                    expr,
                    &mut |name| self.input(id, name, cx, depth).unwrap_or_else(empty),
                    &clock,
                )
            }
            NodeKind::If {
                branches,
                otherwise,
                ..
            } => {
                let chosen = self.branch(id, branches, cx, depth);
                if port != "out" {
                    // A branch read as a value: 1 when it is the one chosen.
                    let p = chosen.map_or("else".to_string(), |i| format!("b{i}"));
                    return LVal::Num((p == port) as u8 as f64);
                }
                let value = chosen.map_or(otherwise.as_str(), |i| branches[i].value.as_str());
                self.value_expr(id, value, cx, depth)
            }
            NodeKind::Lookup {
                rows,
                otherwise,
                contains,
            } => {
                let key = expr::text(&self.input(id, "in", cx, depth).unwrap_or_else(empty))
                    .trim()
                    .to_lowercase();
                let hit = rows.iter().find(|r| {
                    let k = r.key.trim().to_lowercase();
                    if *contains {
                        !k.is_empty() && key.contains(&k)
                    } else {
                        k == key
                    }
                });
                LVal::Text(hit.map_or(otherwise.clone(), |r| r.value.clone()))
            }
            NodeKind::Event { .. } | NodeKind::TriggerIn { .. } | NodeKind::Continue {} => {
                LVal::Num(cx.data.get(&event_key(id)).is_some_and(|v| v == "1") as u8 as f64)
            }
            NodeKind::Var { name, test } => match cx.data.get(&var_key(name)) {
                Some(v) => match v.trim().replace(',', ".").parse::<f64>() {
                    Ok(x) => LVal::Num(x),
                    Err(_) => LVal::Text(v.clone()),
                },
                None => LVal::Num(*test),
            },
            NodeKind::Counter { start, .. } => LVal::Num(
                cx.data
                    .get(&count_key(id))
                    .and_then(|v| v.trim().parse::<f64>().ok())
                    .unwrap_or(*start),
            ),
            NodeKind::OnAir { template, test, .. } => LVal::Num(
                cx.data
                    .get(&on_air_key(template))
                    .and_then(|v| v.trim().parse::<f64>().ok())
                    .unwrap_or(if *test { 1.0 } else { 0.0 }),
            ),
            NodeKind::SetField { .. } => self.input(id, "in", cx, depth).unwrap_or_else(empty),
            NodeKind::Playlist { playlist } => {
                let key = match port {
                    "interrupted" => interrupted_key(playlist),
                    "ended" => ended_key(playlist),
                    _ => playlist_air_key(playlist),
                };
                LVal::Num(cx.data.get(&key).is_some_and(|v| v == "1") as u8 as f64)
            }
            NodeKind::Template { template } => LVal::Num(
                cx.data
                    .get(&on_air_key(template))
                    .and_then(|v| v.trim().parse::<f64>().ok())
                    .map_or(0.0, |v| (v > 0.5) as u8 as f64),
            ),
            _ => LVal::Num(0.0),
        }
    }

    /// The first branch of an If whose condition holds.
    pub fn branch(
        &self,
        id: &str,
        branches: &[Branch],
        cx: &mut Cx,
        depth: usize,
    ) -> Option<usize> {
        branches.iter().position(|b| {
            !b.when.trim().is_empty() && expr::truthy(&self.value_expr(id, &b.when, cx, depth))
        })
    }

    /// An expression of node `id` over its inputs.
    fn value_expr(&self, id: &str, e: &str, cx: &mut Cx, depth: usize) -> LVal {
        let clock = cx.clock;
        expr::run(
            e,
            &mut |name| {
                self.input(id, name, cx, depth)
                    .unwrap_or(LVal::Text(String::new()))
            },
            &clock,
        )
    }
}

/// What the evaluation reads: the layers' values, the data, the text
/// measure and the time.
pub struct Cx<'v, 'm> {
    pub values: &'v Values,
    pub data: &'v Data,
    pub measure: &'v mut Measure<'m>,
    pub clock: Clock,
}

/// The value inputs of a node kind (for walking upstream).
pub fn input_ports(k: &NodeKind) -> Vec<String> {
    match k {
        NodeKind::Expr { inputs, .. } | NodeKind::If { inputs, .. } => inputs.clone(),
        NodeKind::Lookup { .. } | NodeKind::SetField { .. } | NodeKind::Check { .. } => {
            vec!["in".into()]
        }
        NodeKind::Layer { rows, .. } => rows.iter().map(|r| r.key.clone()).collect(),
        NodeKind::Wait { .. } => vec!["seconds".into()],
        NodeKind::SetVar { .. } => vec!["value".into()],
        _ => Vec::new(),
    }
}

/// A number as a text shows it: whole, or with at most 2 decimals.
pub fn format_number(x: f64) -> String {
    if !x.is_finite() {
        return String::new();
    }
    let r = (x * 100.0).round() / 100.0;
    if r.fract() == 0.0 {
        format!("{}", r as i64)
    } else {
        let s = format!("{r:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn layer_values(t: &crate::model::Template, frame: f64, data: &Data) -> Values {
    let hold = t.hold_frame();
    t.layers
        .iter()
        .map(|l| {
            (
                l.id.clone(),
                crate::anim::resolve_layer(l, frame, data, hold).values,
            )
        })
        .collect()
}

/// `data` with the values the graph writes (« Set field » nodes: a
/// calculation shown in a text), from the layers at `frame`; None when the
/// template's graph writes none.
pub fn with_outputs(
    t: &crate::model::Template,
    frame: f64,
    data: &Data,
    clock: Clock,
) -> Option<Data> {
    let outs: Vec<&Node> = t
        .logic
        .nodes
        .iter()
        .filter(|n| matches!(n.kind, NodeKind::SetField { .. }))
        .collect();
    if outs.is_empty() {
        return None;
    }
    let values = layer_values(t, frame, data);
    let logic = current(&t.logic);
    let g = Graph::new(&logic);
    let mut measure = |_: &str, _: &BTreeMap<Prop, Value>, _: TextMetric| 0.0;
    let mut cx = Cx {
        values: &values,
        data,
        measure: &mut measure,
        clock,
    };
    let mut out = data.clone();
    for n in outs {
        let NodeKind::SetField { key } = &n.kind else {
            continue;
        };
        if !g.acts(&n.id) {
            continue;
        }
        let v = g.eval(&n.id, "out", &mut cx, 0);
        out.insert(key.clone(), expr::text(&v));
    }
    Some(out)
}

/// The template with the contents its Layer nodes set (`content.text`…),
/// from the layers at `frame`; None when its graph sets none.
pub fn patched(
    t: &crate::model::Template,
    frame: f64,
    data: &Data,
    clock: Clock,
) -> Option<crate::model::Template> {
    let logic = current(&t.logic);
    let g = Graph::new(&logic);
    let mut sets: Vec<(&str, &str, &str)> = Vec::new();
    for n in &logic.nodes {
        let NodeKind::Layer { layer, rows } = &n.kind else {
            continue;
        };
        for r in rows {
            if let Some(path) = r.key.strip_prefix("content.") {
                if g.acts(&n.id) && g.inputs.contains_key(&(n.id.as_str(), r.key.as_str())) {
                    sets.push((n.id.as_str(), layer.as_str(), path));
                }
            }
        }
    }
    if sets.is_empty() {
        return None;
    }
    let values = layer_values(t, frame, data);
    let mut measure = |_: &str, _: &BTreeMap<Prop, Value>, _: TextMetric| 0.0;
    let mut cx = Cx {
        values: &values,
        data,
        measure: &mut measure,
        clock,
    };
    let mut out = t.clone();
    for (node, layer, path) in sets {
        let Some(v) = g.input(node, &format!("content.{path}"), &mut cx, 0) else {
            continue;
        };
        let Some(l) = out.layers.iter_mut().find(|l| l.id == layer) else {
            continue;
        };
        let Ok(mut j) = serde_json::to_value(&*l) else {
            continue;
        };
        let keys: Vec<&str> = path.split('.').collect();
        let parent = format!("/{}", keys[..keys.len() - 1].join("/"));
        let at = if keys.len() == 1 {
            Some(&mut j)
        } else {
            j.pointer_mut(&parent)
        };
        if let Some(obj) = at.and_then(|a| a.as_object_mut()) {
            obj.insert(
                keys[keys.len() - 1].to_string(),
                serde_json::Value::String(expr::text(&v)),
            );
        }
        if let Ok(nl) = serde_json::from_value(j) {
            *l = nl;
        }
    }
    Some(out)
}

/// The data key of a graphic's presence on air (0 → 1), read by [`NodeKind::OnAir`].
pub fn on_air_key(template: &str) -> String {
    format!("__onair_{template}")
}

/// The data key of what a playlist last took (changes at each take), read by [`NodeKind::Playlist`].
pub fn played_key(playlist: &str) -> String {
    format!("__played_{playlist}")
}

/// The data key of a playlist on air (`1`: a row of it is on air).
pub fn playlist_air_key(playlist: &str) -> String {
    format!("__plair_{playlist}")
}

/// The data key of a playlist interrupted (`1`: its graphic was replaced by another playlist's).
pub fn interrupted_key(playlist: &str) -> String {
    format!("__plint_{playlist}")
}

/// The data key of a playlist done (`1`: its last row has gone out).
pub fn ended_key(playlist: &str) -> String {
    format!("__ended_{playlist}")
}

/// The graphics whose presence the graph reads, with their transition (s).
pub fn on_air_watched(logic: &Logic) -> Vec<(&str, f64)> {
    logic
        .nodes
        .iter()
        .filter_map(|n| match &n.kind {
            NodeKind::OnAir {
                template,
                transition,
                ..
            } => Some((template.as_str(), *transition)),
            _ => None,
        })
        .collect()
}

/// The graph has nodes the server runs on air: flows, variables, counters.
pub fn drives_air(logic: &Logic) -> bool {
    logic.nodes.iter().any(|n| {
        !n.kind.flow_inputs().is_empty()
            || !n.kind.flow_outputs().is_empty()
            || matches!(n.kind, NodeKind::Var { .. })
    })
}

/// Applies the graph's targets (the Layer rows set by a wire) to `values`,
/// in dependency order (a target reading what another one writes comes
/// after it; cycles are skipped).
pub fn apply(logic: &Logic, values: &mut Values, data: &Data, measure: &mut Measure, clock: Clock) {
    if logic.nodes.is_empty() {
        return;
    }
    let logic = &*current(logic);
    let g = Graph::new(logic);
    // (node, layer, property, mode)
    let mut targets: Vec<(&str, &str, Prop, TargetMode, &str)> = Vec::new();
    for n in &logic.nodes {
        let NodeKind::Layer { layer, rows } = &n.kind else {
            continue;
        };
        if !g.acts(&n.id) {
            continue;
        }
        for r in rows {
            if let Some(p) = prop_of(&r.key) {
                if g.inputs.contains_key(&(n.id.as_str(), r.key.as_str())) {
                    targets.push((n.id.as_str(), layer.as_str(), p, r.mode, r.key.as_str()));
                }
            }
        }
    }
    if targets.is_empty() {
        return;
    }
    let reads: Vec<HashSet<(String, Option<Prop>)>> = targets
        .iter()
        .map(|(node, .., key)| {
            let mut out = HashSet::new();
            g.reads(node, key, &mut HashSet::new(), &mut out);
            out
        })
        .collect();
    // Kahn's algorithm over "target i must run before target j".
    let n = targets.len();
    let mut indeg = vec![0usize; n];
    let mut after: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        let (_, layer, prop, ..) = targets[i];
        for j in 0..n {
            if i != j
                && (reads[j].contains(&(layer.to_string(), Some(prop)))
                    || reads[j].contains(&(layer.to_string(), None)))
            {
                after[i].push(j);
                indeg[j] += 1;
            }
        }
    }
    let mut ready: std::collections::VecDeque<usize> = (0..n).filter(|&i| indeg[i] == 0).collect();
    let mut order = Vec::with_capacity(n);
    while let Some(i) = ready.pop_front() {
        order.push(i);
        for &j in &after[i] {
            indeg[j] -= 1;
            if indeg[j] == 0 {
                ready.push_back(j);
            }
        }
    }
    for i in order {
        let (node, layer, prop, mode, key) = targets[i];
        let v = {
            let mut cx = Cx {
                values,
                data,
                measure,
                clock,
            };
            match g.input(node, key, &mut cx, 0) {
                Some(v) => v,
                None => continue,
            }
        };
        let Some(layer_values) = values.get_mut(layer) else {
            continue;
        };
        if prop.is_color() {
            if let Some(c) = Color::from_hex(&expr::text(&v)) {
                layer_values.insert(prop, Value::Color(c));
            }
            continue;
        }
        let current = layer_values
            .get(&prop)
            .and_then(Value::as_number)
            .unwrap_or(0.0);
        let x = v.num();
        let out = match mode {
            TargetMode::Set => x,
            TargetMode::Add => current + x,
            TargetMode::Multiply => current * x,
        };
        if out.is_finite() {
            layer_values.insert(prop, Value::Number(out));
        }
    }
}

/// The layers whose values the graph sets.
pub fn targeted(logic: &Logic) -> HashSet<&str> {
    let wired: HashSet<(&str, &str)> = logic
        .edges
        .iter()
        .map(|e| (e.to.as_str(), e.port.as_str()))
        .collect();
    logic
        .nodes
        .iter()
        .filter_map(|n| match &n.kind {
            NodeKind::Layer { layer, rows }
                if rows.iter().any(|r| {
                    prop_of(&r.key).is_some() && wired.contains(&(n.id.as_str(), r.key.as_str()))
                }) =>
            {
                Some(layer.as_str())
            }
            _ => None,
        })
        .collect()
}

/// Where a graph runs: in a graphic, or as the project's Logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Graphic,
    Project,
}

/// The graph as the engine runs it: an older one made over (see
/// [`upgrade`]), its When and If… steps made into the nodes that do them
/// (see [`lower`]); a graphic's.
pub fn current(logic: &Logic) -> std::borrow::Cow<'_, Logic> {
    current_in(logic, Scope::Graphic)
}

/// [`current`] for a graph running in `scope`.
pub fn current_in(logic: &Logic, scope: Scope) -> std::borrow::Cow<'_, Logic> {
    let steps = logic
        .nodes
        .iter()
        .any(|n| matches!(n.kind, NodeKind::When { .. } | NodeKind::Check { .. }));
    let old = logic.nodes.iter().any(|n| {
        matches!(
            n.kind,
            NodeKind::LayerProp { .. }
                | NodeKind::TextSize { .. }
                | NodeKind::Target { .. }
                | NodeKind::Math { .. }
                | NodeKind::Clamp { .. }
                | NodeKind::Condition { .. }
                | NodeKind::Bool { .. }
        )
    }) || logic.edges.iter().any(|e| e.port == "when");
    if !old && !steps {
        return std::borrow::Cow::Borrowed(logic);
    }
    let mut l = logic.clone();
    if old {
        upgrade(&mut l);
    }
    if steps {
        lower(&mut l, scope);
    }
    std::borrow::Cow::Owned(l)
}

/// The node wired into input `port` of `id`.
fn source_of<'a>(logic: &'a Logic, id: &str, port: &str) -> Option<&'a Node> {
    let e = logic.edges.iter().find(|e| e.to == id && e.port == port)?;
    logic.nodes.iter().find(|n| n.id == e.from)
}

/// Makes the When and If… steps into the nodes that do them, keeping their
/// ids (the flows wired from them go on from there):
/// - When: an Event (a layer's moment, another graphic in / out, a value
///   that changes, the last row), Start, Continue, a trigger received,
///   Every; in the project, a graphic or a playlist node whose flow it is.
///   A variable's or a field's change stays a When (see [`flow`]).
/// - If…: an If over one input per line (`v0`, `v1`…: the subject, `w0`…:
///   the value compared with), from nodes added beside it (`<id>~v0`…).
pub fn lower(logic: &mut Logic, scope: Scope) {
    use crate::model::TriggerEvent as Ev;
    let mut kinds: Vec<(String, NodeKind)> = Vec::new();
    let mut from_ports: Vec<(String, String)> = Vec::new(); // (node, its new flow port for `out`)
    let mut added: Vec<Node> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut renames: Vec<(String, &'static str, &'static str)> = Vec::new(); // (node, old port, new)
    for n in &logic.nodes {
        match &n.kind {
            NodeKind::When {
                on,
                name,
                seconds,
                dataset,
            } => {
                let src = source_of(logic, &n.id, "src").map(|s| &s.kind);
                let ev = |e: Ev| Some(NodeKind::Event { on: e });
                let new = match (src, on.as_str()) {
                    (Some(NodeKind::Template { template }), "in" | "out") => match scope {
                        Scope::Project => {
                            from_ports.push((n.id.clone(), on.clone()));
                            Some(NodeKind::Template {
                                template: template.clone(),
                            })
                        }
                        Scope::Graphic => ev(Ev::Graphic {
                            template: template.clone(),
                            out: on == "out",
                        }),
                    },
                    (Some(NodeKind::OnAir { template, .. }), "in" | "out") => ev(Ev::Graphic {
                        template: template.clone(),
                        out: on == "out",
                    }),
                    (Some(NodeKind::Playlist { playlist }), "taken" | "end" | "interrupted") => {
                        from_ports.push((n.id.clone(), on.clone()));
                        Some(NodeKind::Playlist {
                            playlist: playlist.clone(),
                        })
                    }
                    (Some(NodeKind::Layer { layer, .. }), "scrollEnd") => ev(Ev::ScrollEnd {
                        layer: layer.clone(),
                        passes: 1,
                    }),
                    (Some(NodeKind::Layer { layer, .. }), "timerZero") => ev(Ev::TimerZero {
                        layer: layer.clone(),
                    }),
                    (Some(NodeKind::Layer { layer, .. }), "timerAt") => ev(Ev::TimerAt {
                        layer: layer.clone(),
                        seconds: *seconds,
                    }),
                    (Some(NodeKind::Layer { layer, .. }), "videoEnd") => ev(Ev::VideoEnd {
                        layer: layer.clone(),
                    }),
                    (Some(NodeKind::Field { .. }) | None, "lastRow") => ev(Ev::LastRow {
                        dataset: dataset.clone(),
                    }),
                    // A field's or a variable's change: watched by the flow itself.
                    (Some(NodeKind::Field { .. } | NodeKind::Var { .. }), "change") => None,
                    (None, "start") => Some(NodeKind::Start {}),
                    (None, "continue") => Some(NodeKind::Continue {}),
                    (None, "trigger") => Some(NodeKind::TriggerIn { name: name.clone() }),
                    (None, "every") => Some(NodeKind::Every {
                        seconds: if *seconds > 0.0 { *seconds } else { 1.0 },
                    }),
                    _ => None,
                };
                if let Some(k) = new {
                    kinds.push((n.id.clone(), k));
                }
            }
            NodeKind::Check { rows, any } => {
                let mut whens = Vec::new();
                let mut inputs = Vec::new();
                for (i, r) in rows.iter().enumerate() {
                    let (v, w) = (format!("v{i}"), format!("w{i}"));
                    let sub = |kind: NodeKind, port: &str| {
                        (
                            Some(Node {
                                id: format!("{}~{v}", n.id),
                                kind,
                                x: n.x,
                                y: n.y,
                                frame: n.frame.clone(),
                                title: None,
                            }),
                            port.to_string(),
                        )
                    };
                    let (node, port) = match r.what.split_once(':') {
                        Some(("tpl", t)) => match scope {
                            Scope::Project => sub(
                                NodeKind::Template {
                                    template: t.to_string(),
                                },
                                "onAir",
                            ),
                            Scope::Graphic => sub(
                                NodeKind::OnAir {
                                    template: t.to_string(),
                                    transition: 0.0,
                                    test: false,
                                },
                                "out",
                            ),
                        },
                        Some(("pl", p)) => sub(
                            NodeKind::Playlist {
                                playlist: p.to_string(),
                            },
                            match r.test.as_str() {
                                "interrupted" | "notInterrupted" => "interrupted",
                                "ended" | "notEnded" => "ended",
                                _ => "onAir",
                            },
                        ),
                        Some(("field", k)) => sub(NodeKind::Field { key: k.to_string() }, "out"),
                        Some(("var", name)) => sub(
                            NodeKind::Var {
                                name: name.to_string(),
                                test: 0.0,
                            },
                            "out",
                        ),
                        _ => (None, String::new()),
                    };
                    match node {
                        Some(node) => {
                            edges.push(Edge {
                                from: node.id.clone(),
                                from_port: port,
                                to: n.id.clone(),
                                port: v.clone(),
                            });
                            added.push(node);
                        }
                        // The value wired into `in`.
                        None if r.what == "in" => {
                            if let Some(e) =
                                logic.edges.iter().find(|e| e.to == n.id && e.port == "in")
                            {
                                edges.push(Edge {
                                    port: v.clone(),
                                    ..e.clone()
                                });
                            }
                        }
                        None => continue,
                    }
                    let cmp = |op: &str| format!("{v} {op} {w}");
                    let test = match r.test.as_str() {
                        "onAir" | "interrupted" | "ended" | "yes" => format!("{v} > 0.5"),
                        "notOnAir" | "notInterrupted" | "notEnded" | "no" => format!("{v} < 0.5"),
                        "gt" => cmp(">"),
                        "ge" => cmp(">="),
                        "lt" => cmp("<"),
                        "le" => cmp("<="),
                        "eq" => cmp("="),
                        "ne" => cmp("!="),
                        "contains" => format!("contient({v}, {w})"),
                        "empty" => format!("vide({v})"),
                        "notEmpty" => format!("non vide({v})"),
                        _ => continue,
                    };
                    if test.contains(&w) {
                        let id = format!("{}~{w}", n.id);
                        edges.push(Edge {
                            from: id.clone(),
                            from_port: "out".into(),
                            to: n.id.clone(),
                            port: w.clone(),
                        });
                        added.push(Node {
                            id,
                            kind: NodeKind::Text {
                                value: r.value.clone(),
                            },
                            x: n.x,
                            y: n.y,
                            frame: n.frame.clone(),
                            title: None,
                        });
                        inputs.push(w);
                    }
                    inputs.push(v);
                    let or = r.join == "or" || (r.join.is_empty() && *any);
                    if !whens.is_empty() {
                        whens.push(if or { "ou" } else { "et" }.to_string());
                    }
                    whens.push(format!("({test})"));
                }
                kinds.push((
                    n.id.clone(),
                    NodeKind::If {
                        inputs,
                        branches: vec![Branch {
                            // No line: never true.
                            // « et » binds before « ou »: (a et b) ou c.
                            when: if whens.is_empty() {
                                "0".into()
                            } else {
                                whens.join(" ")
                            },
                            value: "1".into(),
                        }],
                        otherwise: "0".into(),
                    },
                ));
                renames.push((n.id.clone(), "yes", "b0"));
                renames.push((n.id.clone(), "no", "else"));
            }
            _ => {}
        }
    }
    for (id, k) in kinds {
        if let Some(n) = logic.nodes.iter_mut().find(|n| n.id == id) {
            n.kind = k;
        }
    }
    for e in &mut logic.edges {
        if let Some((_, p)) = from_ports.iter().find(|(id, _)| *id == e.from) {
            if e.from_port == "out" {
                e.from_port = p.clone();
            }
        }
        if let Some((_, _, new)) = renames
            .iter()
            .find(|(id, old, _)| *id == e.from && e.from_port == *old)
        {
            e.from_port = (*new).into();
        }
    }
    logic.nodes.extend(added);
    logic.edges.extend(edges);
}

/// Makes an older graph over: one Layer node for a layer property, a text
/// size or a target; a Calculation for a math, a clamp or an and / or; an
/// If for a condition; `when` inputs become `run`. True when it changed.
pub fn upgrade(logic: &mut Logic) -> bool {
    let mut changed = false;
    let wired: HashSet<(String, String)> = logic
        .edges
        .iter()
        .map(|e| (e.to.clone(), e.port.clone()))
        .collect();
    let mut renames: HashMap<String, String> = HashMap::new(); // node id → its output port
    let mut ins: HashMap<(String, String), String> = HashMap::new(); // (node, old port) → new port
    for n in &mut logic.nodes {
        let new = match &n.kind {
            NodeKind::LayerProp { layer, prop } => {
                renames.insert(n.id.clone(), prop_key(*prop));
                NodeKind::Layer {
                    layer: layer.clone(),
                    rows: vec![LayerRow {
                        key: prop_key(*prop),
                        mode: TargetMode::Set,
                    }],
                }
            }
            NodeKind::TextSize { layer, metric } => {
                let key = format!(
                    "text.{}",
                    match metric {
                        TextMetric::Width => "width",
                        TextMetric::Height => "height",
                        TextMetric::Lines => "lines",
                        TextMetric::Chars => "chars",
                    }
                );
                renames.insert(n.id.clone(), key.clone());
                NodeKind::Layer {
                    layer: layer.clone(),
                    rows: vec![LayerRow {
                        key,
                        mode: TargetMode::Set,
                    }],
                }
            }
            NodeKind::Target { layer, prop, mode } => {
                ins.insert((n.id.clone(), "in".into()), prop_key(*prop));
                NodeKind::Layer {
                    layer: layer.clone(),
                    rows: vec![LayerRow {
                        key: prop_key(*prop),
                        mode: *mode,
                    }],
                }
            }
            NodeKind::Math { op } => NodeKind::Expr {
                expr: match op {
                    MathOp::Add => "a + b",
                    MathOp::Sub => "a - b",
                    MathOp::Mul => "a * b",
                    MathOp::Div => "a / b",
                    MathOp::Min => "min(a, b)",
                    MathOp::Max => "max(a, b)",
                    MathOp::Abs => "abs(a)",
                    MathOp::Round => "arrondi(a)",
                    MathOp::Floor => "plancher(a)",
                    MathOp::Ceil => "plafond(a)",
                }
                .into(),
                inputs: ab(),
            },
            NodeKind::Clamp { min, max } => NodeKind::Expr {
                expr: format!(
                    "limiter(in, {}, {})",
                    format_number(*min),
                    format_number(*max)
                ),
                inputs: vec!["in".into()],
            },
            NodeKind::Bool { op } => NodeKind::Expr {
                expr: if *op == BoolOp::And {
                    "a et b"
                } else {
                    "a ou b"
                }
                .into(),
                inputs: ab(),
            },
            NodeKind::Condition { cmp } => {
                let has = |p: &str| wired.contains(&(n.id.clone(), p.to_string()));
                NodeKind::If {
                    inputs: vec!["a".into(), "b".into(), "then".into(), "else".into()],
                    branches: vec![Branch {
                        when: match cmp {
                            Cmp::Gt => "a > b",
                            Cmp::Ge => "a >= b",
                            Cmp::Lt => "a < b",
                            Cmp::Le => "a <= b",
                            Cmp::Eq => "a = b",
                            Cmp::Ne => "a != b",
                            Cmp::Empty => "vide(a)",
                            Cmp::NotEmpty => "non vide(a)",
                        }
                        .into(),
                        value: if has("then") { "then" } else { "1" }.into(),
                    }],
                    otherwise: if has("else") { "else" } else { "0" }.into(),
                }
            }
            _ => continue,
        };
        n.kind = new;
        changed = true;
    }
    for e in &mut logic.edges {
        if let Some(p) = renames.get(&e.from) {
            e.from_port = p.clone();
        }
        if let Some(p) = ins.get(&(e.to.clone(), e.port.clone())) {
            e.port = p.clone();
            changed = true;
        }
        if e.port == "when" {
            e.port = "run".into();
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests;
