//! Widgets built with the Builder (Designer): a definition made of plain
//! elements (shapes, texts, the base widgets), variables, options and
//! controls.
//!
//! In a template, a built widget is a folder ([`crate::model::Layer::widget`])
//! holding the elements generated from its definition (by the Designer,
//! `web/src/engine/built.ts`): the renderers draw them as any layer. Its
//! variables are values of the graphic, under [`var_key`]; this module runs
//! its controls on them, and sends the Temps among its elements what their
//! controls ask. Mirror: `web/src/engine/built.ts` (`act`), which runs them in
//! the Operator's preview and in the Designer.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::anim::Data;
use crate::model::Layer;

/// A widget made with the Builder (saved in its project).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "DefIn")]
pub struct Def {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub vars: Vec<Var>,
    #[serde(default)]
    pub controls: Vec<Control>,
    /// Its elements, options, icon… as the Builder wrote them.
    #[serde(flatten)]
    pub rest: BTreeMap<String, Value>,
}

/// A definition as stored: its elements made with the widgets of before are
/// read as what they became ([`crate::old_widgets`]).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefIn {
    id: String,
    name: String,
    #[serde(default)]
    vars: Vec<Var>,
    #[serde(default)]
    controls: Vec<Control>,
    #[serde(flatten)]
    rest: BTreeMap<String, Value>,
}

impl From<DefIn> for Def {
    fn from(d: DefIn) -> Self {
        let mut rest = d.rest;
        if let Some(Value::Array(layers)) = rest.get_mut("layers") {
            *layers = crate::old_widgets::convert(std::mem::take(layers));
        }
        Self {
            id: d.id,
            name: d.name,
            vars: d.vars,
            controls: d.controls,
            rest,
        }
    }
}

/// A variable of a widget: what its controls change and its elements show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Var {
    pub name: String,
    /// Its value at the start (the template's start value comes first).
    #[serde(default)]
    pub initial: String,
    /// The values it goes through (a list: Q1, Q2…).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub list: Vec<String>,
    /// Kept after the graphic has been on air (the next take starts from
    /// it); else each take starts from the start value.
    #[serde(default = "yes")]
    pub keep: bool,
    #[serde(flatten)]
    pub rest: BTreeMap<String, Value>,
}

fn yes() -> bool {
    true
}

/// A control of a widget: a button (or a field) of the Operator, and what it does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub id: String,
    #[serde(default)]
    pub actions: Vec<Action>,
    /// Its label, icon, key, place… (the Operator's).
    #[serde(flatten)]
    pub rest: BTreeMap<String, Value>,
}

/// One thing a control does.
///
/// `op`: `add` (`value` to a number), `set` (to `value`), `toggle` (true /
/// false), `next` / `prev` (in its list, or ± 1; stops at the ends),
/// `cycle` (next, round again), `reset` (to the start value; no `var`: all),
/// `undo` (the last control's changes), `timer` (the Temps `layer`: `value`
/// is its action — start, pause, toggle, reset, restart, adjust, set — and
/// `arg` its argument: seconds, a time).
///
/// `value` / `arg` `$value`: what the operator typed (a field).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub op: String,
    #[serde(default)]
    pub var: String,
    #[serde(default)]
    pub value: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub layer: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub arg: String,
}

/// The layer is an element of a built widget (a folder with `widget` above it): the widget's
/// controls drive it (its Temps do not wait for the operator's Continue).
pub fn inside_widget(layers: &[Layer], l: &Layer) -> bool {
    let mut p = l.parent.as_deref();
    for _ in 0..layers.len() {
        let Some(f) = p.and_then(|id| layers.iter().find(|x| x.id == id)) else {
            return false;
        };
        if f.widget.is_some() {
            return true;
        }
        p = f.parent.as_deref();
    }
    false
}

/// The data key of the variable `var` of the widget `widget` (its layer id).
pub fn var_key(widget: &str, var: &str) -> String {
    let id: String = widget
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("w_{id}_{var}")
}

/// The id of an element of the widget `widget` in its template.
pub fn element_id(widget: &str, element: &str) -> String {
    format!("{widget}/{element}")
}

/// What a control asks a Temps of the widget (an element's own action).
#[derive(Debug, Clone, PartialEq)]
pub struct Forward {
    /// The element's layer id in the template.
    pub layer: String,
    pub op: String,
    pub args: Value,
}

/// The changes a widget remembers to undo them (in its operator state).
#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    /// The values before each control, last at the end.
    #[serde(default)]
    hist: Vec<BTreeMap<String, String>>,
}

/// Steps kept for Undo.
const UNDO_STEPS: usize = 50;

fn num(s: &str) -> Option<f64> {
    s.trim()
        .replace(',', ".")
        .parse::<f64>()
        .ok()
        .filter(|x| x.is_finite())
}

/// A number written back: whole numbers without decimals.
fn fmt_num(x: f64) -> String {
    if (x - x.round()).abs() < 1e-9 {
        format!("{}", x.round() as i64)
    } else {
        let s = format!("{x:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn truthy(s: &str) -> bool {
    matches!(
        s.trim().to_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
}

/// The start value of `var` in this template (else the definition's).
pub fn start_value(def: &Def, layer: &Layer, var: &str) -> String {
    layer
        .widget
        .as_ref()
        .and_then(|w| w.vars.get(var).cloned())
        .or_else(|| {
            def.vars
                .iter()
                .find(|v| v.name == var)
                .map(|v| v.initial.clone())
        })
        .unwrap_or_default()
}

/// The values its variables start from, by data key (the template's data).
pub fn start_data(def: &Def, layer: &Layer) -> Data {
    def.vars
        .iter()
        .map(|v| {
            (
                var_key(&layer.id, &v.name),
                start_value(def, layer, &v.name),
            )
        })
        .collect()
}

/// Runs the control `control` of the widget placed as `layer` on the values
/// of the graphic (`data`); `state` is its operator state, `arg` what came
/// with the press (`{"value": …}` typed in a field). Returns what goes to
/// its Temps.
pub fn act(
    def: &Def,
    layer: &Layer,
    data: &mut Data,
    state: &mut Value,
    control: &str,
    arg: &Value,
) -> Result<Vec<Forward>, String> {
    let c = def
        .controls
        .iter()
        .find(|c| c.id == control)
        .ok_or_else(|| format!("{}: no control “{control}”", def.name))?;
    let mut st: State = serde_json::from_value(state.clone()).unwrap_or_default();
    let typed = match arg.get("value") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(v) => Some(v.to_string()),
    };
    let value_of = |raw: &str| -> Result<String, String> {
        if raw.trim() == "$value" {
            typed
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| "a value is needed".to_string())
        } else {
            Ok(raw.to_string())
        }
    };
    let current = |data: &Data, var: &str| -> String {
        data.get(&var_key(&layer.id, var))
            .cloned()
            .unwrap_or_else(|| start_value(def, layer, var))
    };
    let mut before: BTreeMap<String, String> = BTreeMap::new();
    let mut set = |data: &mut Data, var: &str, v: String| {
        let key = var_key(&layer.id, var);
        let old = data
            .get(&key)
            .cloned()
            .unwrap_or_else(|| start_value(def, layer, var));
        before.entry(key.clone()).or_insert(old);
        data.insert(key, v);
    };
    let mut out = Vec::new();
    for a in &c.actions {
        let var = a.var.trim();
        let known = || {
            def.vars
                .iter()
                .find(|v| v.name == var)
                .ok_or_else(|| format!("{}: no variable “{var}”", def.name))
        };
        match a.op.as_str() {
            "add" => {
                known()?;
                let by = value_of(&a.value)?;
                let by = num(&by).ok_or_else(|| format!("“{by}” is not a number"))?;
                let v = num(&current(data, var)).unwrap_or(0.0) + by;
                set(data, var, fmt_num(v));
            }
            "set" => {
                known()?;
                let v = value_of(&a.value)?;
                set(data, var, v);
            }
            "toggle" => {
                known()?;
                let on = truthy(&current(data, var));
                set(data, var, (!on).to_string());
            }
            "next" | "prev" | "cycle" => {
                let v = known()?;
                let cur = current(data, var);
                let back = a.op == "prev";
                let new = if v.list.is_empty() {
                    let n = num(&cur).unwrap_or(0.0) + if back { -1.0 } else { 1.0 };
                    fmt_num(n)
                } else {
                    let len = v.list.len() as i64;
                    let at = v
                        .list
                        .iter()
                        .position(|x| x == &cur)
                        .map_or(-1, |i| i as i64);
                    let to = if a.op == "cycle" {
                        (at + 1).rem_euclid(len)
                    } else if back {
                        (at - 1).max(0)
                    } else {
                        (at + 1).min(len - 1)
                    };
                    v.list[to as usize].clone()
                };
                set(data, var, new);
            }
            "reset" => {
                let vars: Vec<&str> = if var.is_empty() {
                    def.vars.iter().map(|v| v.name.as_str()).collect()
                } else {
                    vec![known()?.name.as_str()]
                };
                for v in vars {
                    set(data, v, start_value(def, layer, v));
                }
            }
            "undo" => {
                let last = st.hist.pop().ok_or("nothing to undo")?;
                for (k, v) in last {
                    data.insert(k, v);
                }
                *state = serde_json::to_value(&st).map_err(|e| e.to_string())?;
                return Ok(Vec::new());
            }
            "timer" => {
                if a.layer.is_empty() {
                    return Err(format!("{}: which Temps?", def.name));
                }
                let op = a.value.trim().to_string();
                let args = match op.as_str() {
                    "adjust" => {
                        let s = value_of(&a.arg)?;
                        let s =
                            num(&s).ok_or_else(|| format!("“{s}” is not a number of seconds"))?;
                        serde_json::json!({ "seconds": s })
                    }
                    "set" => serde_json::json!({ "value": value_of(&a.arg)? }),
                    _ => Value::Null,
                };
                out.push(Forward {
                    layer: element_id(&layer.id, &a.layer),
                    op,
                    args,
                });
            }
            other => return Err(format!("{}: unknown action “{other}”", def.name)),
        }
    }
    if !before.is_empty() {
        st.hist.push(before);
        if st.hist.len() > UNDO_STEPS {
            st.hist.remove(0);
        }
    }
    *state = serde_json::to_value(&st).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The trigger a button of the widget placed as `widget` fires (its Logic
/// starts there: a `Control` node of the Builder becomes a trigger with this
/// name in the template).
pub fn control_trigger(widget: &str, control: &str) -> String {
    format!("__w:{widget}:{control}")
}

/// The pulse that keeps what was typed in a field of the widget `widget`
/// for the press's flow (`$value`).
pub fn typed_key(widget: &str) -> String {
    format!("wv:{widget}")
}

/// A variable's new value: `op` (add, set, toggle, next, prev, cycle, reset)
/// on `cur`, with `value`; `list` its values, `start` its start value.
pub fn op_value(
    cur: &str,
    op: &str,
    value: &str,
    list: &[String],
    start: &str,
) -> Result<String, String> {
    Ok(match op {
        "add" => {
            let by = num(value).ok_or_else(|| format!("“{value}” is not a number"))?;
            fmt_num(num(cur).unwrap_or(0.0) + by)
        }
        "set" => value.to_string(),
        "toggle" => (!truthy(cur)).to_string(),
        "next" | "prev" | "cycle" => {
            let back = op == "prev";
            if list.is_empty() {
                fmt_num(num(cur).unwrap_or(0.0) + if back { -1.0 } else { 1.0 })
            } else {
                let len = list.len() as i64;
                let at = list.iter().position(|x| x == cur).map_or(-1, |i| i as i64);
                let to = if op == "cycle" {
                    (at + 1).rem_euclid(len)
                } else if back {
                    (at - 1).max(0)
                } else {
                    (at + 1).min(len - 1)
                };
                list[to as usize].clone()
            }
        }
        "reset" => start.to_string(),
        other => return Err(format!("unknown change “{other}”")),
    })
}

/// What goes with an element's action `op` asked by a widget's Logic: the
/// seconds to add (adjust), else the value (a time to set…).
pub fn element_args(op: &str, arg: &str) -> Value {
    if arg.trim().is_empty() {
        return Value::Null;
    }
    match (op, num(arg)) {
        ("adjust", Some(s)) => serde_json::json!({ "seconds": s }),
        _ => serde_json::json!({ "value": arg }),
    }
}

/// The values of a press before it changed them, per widget: one Undo step
/// each once the press is done ([`end_steps`]).
pub type Steps = BTreeMap<String, BTreeMap<String, String>>;

/// « Change a variable » of a widget's Logic: `op` on the variable `key` (on
/// every variable of `all` when `key` is empty: Reset all), its old value
/// kept in `steps` for Undo. `value` is already what was typed (`$value`).
#[allow(clippy::too_many_arguments)]
pub fn change_var(
    data: &mut Data,
    steps: &mut Steps,
    widget: &str,
    key: &str,
    op: &str,
    value: &str,
    list: &[String],
    start: &str,
    all: &BTreeMap<String, String>,
) -> Result<(), String> {
    let keys: Vec<(&str, &str)> = if key.is_empty() {
        all.iter().map(|(k, s)| (k.as_str(), s.as_str())).collect()
    } else {
        vec![(key, start)]
    };
    let step = steps.entry(widget.to_string()).or_default();
    for (k, start) in keys {
        let cur = data.get(k).cloned().unwrap_or_else(|| start.to_string());
        let v = op_value(&cur, op, value, list, start)?;
        step.entry(k.to_string()).or_insert(cur);
        data.insert(k.to_string(), v);
    }
    Ok(())
}

/// The press is done: one Undo step per widget it changed.
pub fn end_steps(states: &mut BTreeMap<String, Value>, steps: Steps) {
    for (w, before) in steps {
        let st = states.entry(w).or_insert(Value::Null);
        push_step(st, before);
    }
}

/// What pressing the control `control` of the widget placed as `widget` does
/// through its Logic `logic` (as placed: [`control_trigger`]s), at once, on
/// the values `data` and the widgets' states `states` (Undo): the changes of
/// values, and what goes to its elements. The Operator's preview and the
/// Builder's try-out; on air the same flows run with the template's.
pub fn press(
    logic: &crate::logic::Logic,
    widget: &str,
    control: &str,
    typed: &str,
    data: &Data,
    states: &mut BTreeMap<String, Value>,
) -> Result<(Data, Vec<Forward>), String> {
    use crate::logic::flow::{run, Act, Tick};
    use crate::logic::{event_key, NodeKind};
    let logic = crate::logic::current(logic);
    let logic = logic.as_ref();
    let name = control_trigger(widget, control);
    let mut tick = data.clone();
    let mut any = false;
    for n in &logic.nodes {
        if let NodeKind::TriggerIn { name: n2 } = &n.kind {
            if n2.trim().eq_ignore_ascii_case(&name) {
                tick.insert(event_key(&n.id), "1".into());
                any = true;
            }
        }
    }
    if !any {
        return Err(format!("no control “{control}”"));
    }
    let acts = run(
        logic,
        &Tick {
            data: &tick,
            secs: 0.0,
            now_ms: 0,
        },
        &mut BTreeMap::new(),
        &mut BTreeMap::new(),
    );
    let mut out = data.clone();
    let mut steps = Steps::new();
    let mut forward = Vec::new();
    let typed_of = |raw: &str| {
        if raw.trim() == "$value" {
            typed.to_string()
        } else {
            raw.to_string()
        }
    };
    for a in acts {
        match a {
            Act::Wvar {
                key,
                op,
                value,
                list,
                start,
                all,
                widget,
            } => change_var(
                &mut out,
                &mut steps,
                &widget,
                &key,
                &op,
                &typed_of(&value),
                &list,
                &start,
                &all,
            )?,
            Act::Wundo { widget } => {
                let st = states.entry(widget).or_insert(Value::Null);
                undo(&mut out, st);
            }
            Act::Widget {
                layer,
                control,
                arg,
            } => {
                let args = element_args(&control, &typed_of(&arg));
                forward.push(Forward {
                    layer,
                    op: control,
                    args,
                });
            }
            _ => {}
        }
    }
    end_steps(states, steps);
    let changed = out
        .into_iter()
        .filter(|(k, v)| data.get(k) != Some(v))
        .collect();
    Ok((changed, forward))
}

/// One Undo step of a widget (the values before a press), in its operator
/// state.
pub fn push_step(state: &mut Value, before: BTreeMap<String, String>) {
    if before.is_empty() {
        return;
    }
    let mut st: State = serde_json::from_value(state.clone()).unwrap_or_default();
    st.hist.push(before);
    if st.hist.len() > UNDO_STEPS {
        st.hist.remove(0);
    }
    if let Ok(v) = serde_json::to_value(&st) {
        *state = v;
    }
}

/// Puts back the values before the widget's last press. False: nothing to undo.
pub fn undo(data: &mut Data, state: &mut Value) -> bool {
    let mut st: State = serde_json::from_value(state.clone()).unwrap_or_default();
    let Some(last) = st.hist.pop() else {
        return false;
    };
    for (k, v) in last {
        data.insert(k, v);
    }
    if let Ok(v) = serde_json::to_value(&st) {
        *state = v;
    }
    true
}

/// The definition of the widget placed as `l`: the one it was made from
/// (its snapshot), else the project's.
pub fn def_of<'a>(defs: &'a [Def], l: &'a Layer) -> Option<&'a Def> {
    let w = l.widget.as_ref()?;
    w.snap
        .as_deref()
        .or_else(|| defs.iter().find(|d| d.id == w.def))
}

/// The values of the template's built widgets kept after the graphic has been
/// on air (variables marked to keep), by data key: what its rundown item
/// keeps for the next take.
pub fn kept(defs: &[Def], layers: &[Layer], data: &Data) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for l in layers {
        let Some(def) = def_of(defs, l) else {
            continue;
        };
        for v in def.vars.iter().filter(|v| v.keep) {
            let key = var_key(&l.id, &v.name);
            if let Some(x) = data.get(&key) {
                out.insert(key, x.clone());
            }
        }
    }
    out
}

/// Values of variables not kept after the graphic (they start again): to
/// drop from its rundown item.
pub fn not_kept(defs: &[Def], layers: &[Layer]) -> Vec<String> {
    let mut out = Vec::new();
    for l in layers {
        let Some(def) = def_of(defs, l) else {
            continue;
        };
        out.extend(
            def.vars
                .iter()
                .filter(|v| !v.keep)
                .map(|v| var_key(&l.id, &v.name)),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def() -> Def {
        serde_json::from_value(serde_json::json!({
            "id": "sb", "name": "Tableau des scores",
            "vars": [
                { "name": "score_1", "initial": "0" },
                { "name": "periode", "initial": "Q1", "list": ["Q1", "Q2", "Q3", "Q4"] },
                { "name": "possession", "initial": "1", "list": ["1", "2"] },
                { "name": "tir", "initial": "24", "keep": false }
            ],
            "controls": [
                { "id": "p3", "label": "+3", "actions": [{ "op": "add", "var": "score_1", "value": "3" }] },
                { "id": "score", "actions": [{ "op": "set", "var": "score_1", "value": "$value" }] },
                { "id": "next", "actions": [{ "op": "next", "var": "periode" }] },
                { "id": "poss", "actions": [{ "op": "cycle", "var": "possession" }] },
                { "id": "undo", "actions": [{ "op": "undo" }] },
                { "id": "reset", "actions": [{ "op": "reset" }, { "op": "timer", "layer": "clk", "value": "reset" }] },
                { "id": "shot", "actions": [{ "op": "timer", "layer": "tir", "value": "set", "arg": "14" }] }
            ],
            "layers": []
        }))
        .unwrap()
    }

    fn layer() -> Layer {
        serde_json::from_value(serde_json::json!({
            "id": "W", "name": "Tableau", "type": "group",
            "widget": { "def": "sb", "vars": { "score_1": "10" } }
        }))
        .unwrap()
    }

    #[test]
    fn controls_change_the_variables_and_undo_puts_them_back() {
        let (d, l) = (def(), layer());
        let mut data = Data::new();
        let mut st = Value::Null;
        let k = var_key("W", "score_1");
        act(&d, &l, &mut data, &mut st, "p3", &Value::Null).unwrap();
        assert_eq!(data[&k], "13", "from the template's start value");
        act(&d, &l, &mut data, &mut st, "p3", &Value::Null).unwrap();
        assert_eq!(data[&k], "16");
        act(
            &d,
            &l,
            &mut data,
            &mut st,
            "score",
            &serde_json::json!({ "value": "42" }),
        )
        .unwrap();
        assert_eq!(data[&k], "42");
        assert!(act(&d, &l, &mut data, &mut st, "score", &Value::Null).is_err());
        act(&d, &l, &mut data, &mut st, "undo", &Value::Null).unwrap();
        assert_eq!(data[&k], "16");
        act(&d, &l, &mut data, &mut st, "undo", &Value::Null).unwrap();
        act(&d, &l, &mut data, &mut st, "undo", &Value::Null).unwrap();
        assert_eq!(data[&k], "10");
        assert!(act(&d, &l, &mut data, &mut st, "undo", &Value::Null).is_err());
    }

    #[test]
    fn lists_stop_at_their_ends_or_go_round() {
        let (d, l) = (def(), layer());
        let mut data = Data::new();
        let mut st = Value::Null;
        for _ in 0..6 {
            act(&d, &l, &mut data, &mut st, "next", &Value::Null).unwrap();
        }
        assert_eq!(data[&var_key("W", "periode")], "Q4");
        act(&d, &l, &mut data, &mut st, "poss", &Value::Null).unwrap();
        assert_eq!(data[&var_key("W", "possession")], "2");
        act(&d, &l, &mut data, &mut st, "poss", &Value::Null).unwrap();
        assert_eq!(data[&var_key("W", "possession")], "1");
    }

    #[test]
    fn a_reset_goes_back_to_the_start_and_the_temps_are_told() {
        let (d, l) = (def(), layer());
        let mut data = Data::new();
        let mut st = Value::Null;
        act(&d, &l, &mut data, &mut st, "p3", &Value::Null).unwrap();
        let fw = act(&d, &l, &mut data, &mut st, "reset", &Value::Null).unwrap();
        assert_eq!(data[&var_key("W", "score_1")], "10");
        assert_eq!(data[&var_key("W", "periode")], "Q1");
        assert_eq!(
            fw,
            vec![Forward {
                layer: "W/clk".into(),
                op: "reset".into(),
                args: Value::Null
            }]
        );
        let fw = act(&d, &l, &mut data, &mut st, "shot", &Value::Null).unwrap();
        assert_eq!(fw[0].args, serde_json::json!({ "value": "14" }));
    }

    #[test]
    fn a_template_starts_its_widgets_from_their_start_values_and_lights_its_copies() {
        let t: crate::model::Template = serde_json::from_value(serde_json::json!({
            "id": "t", "name": "T", "duration": 50.0,
            "layers": [
                { "id": "W", "name": "Tableau", "type": "group", "widget": { "def": "sb", "vars": { "fautes": "2" } } },
                { "id": "W/pip#1", "name": "Pastille", "parent": "W", "type": "ellipse",
                  "lit": { "key": "w_W_fautes", "index": 1, "off": 0.25 } },
                { "id": "W/pip#2", "name": "Pastille", "parent": "W", "type": "ellipse",
                  "lit": { "key": "w_W_fautes", "index": 2, "off": 0.25 } }
            ]
        }))
        .unwrap();
        let mut data = t.default_data();
        assert_eq!(data[&var_key("W", "fautes")], "2");
        let op = |l: &Layer, d: &Data| {
            crate::anim::resolve_layer(l, 0.0, d, 0.0).values[&crate::model::Prop::Opacity]
                .as_number()
                .unwrap()
        };
        assert_eq!(op(&t.layers[1], &data), 1.0, "2 > 1: lit");
        assert_eq!(op(&t.layers[2], &data), 0.25, "2 is not > 2: dimmed");
        data.insert(var_key("W", "fautes"), "3".into());
        assert_eq!(op(&t.layers[2], &data), 1.0);
    }

    #[test]
    fn only_the_variables_to_keep_go_back_to_the_rundown() {
        let (d, l) = (def(), layer());
        let mut data = start_data(&d, &l);
        data.insert("other".into(), "x".into());
        let k = kept(std::slice::from_ref(&d), std::slice::from_ref(&l), &data);
        assert!(k.contains_key(&var_key("W", "score_1")));
        assert!(!k.contains_key(&var_key("W", "tir")));
        assert!(!k.contains_key("other"));
        assert_eq!(not_kept(&[d], &[l]), vec![var_key("W", "tir")]);
    }

    #[test]
    fn a_widgets_elements_are_inside_it() {
        let el = |id: &str, parent: Option<&str>| -> Layer {
            serde_json::from_value(
                serde_json::json!({ "id": id, "name": id, "type": "group", "parent": parent }),
            )
            .unwrap()
        };
        let layers = vec![
            layer(),
            el("W/eq1", Some("W")),
            el("W/chrono", Some("W/eq1")),
            el("free", None),
        ];
        assert!(inside_widget(&layers, &layers[1]));
        assert!(inside_widget(&layers, &layers[2]));
        assert!(!inside_widget(&layers, &layers[0]));
        assert!(!inside_widget(&layers, &layers[3]));
    }

    /// A widget's Logic: « +1 » adds one to its score, « Undo » puts it back,
    /// « Set » takes what was typed; « Start » tells its Temps.
    fn press_logic() -> crate::logic::Logic {
        serde_json::from_value(serde_json::json!({
            "nodes": [
                { "id": "W/a", "type": "triggerIn", "name": "__w:W:plus" },
                { "id": "W/b", "type": "wvar", "var": "w_W_score", "op": "add", "value": "1", "start": "0", "widget": "W" },
                { "id": "W/c", "type": "triggerIn", "name": "__w:W:undo" },
                { "id": "W/d", "type": "wundo", "widget": "W" },
                { "id": "W/e", "type": "triggerIn", "name": "__w:W:set" },
                { "id": "W/f", "type": "wvar", "var": "w_W_score", "op": "set", "value": "$value", "widget": "W" },
                { "id": "W/g", "type": "triggerIn", "name": "__w:W:go" },
                { "id": "W/h", "type": "widget", "layer": "W/clock", "control": "start" }
            ],
            "edges": [
                { "from": "W/a", "to": "W/b", "port": "run" },
                { "from": "W/c", "to": "W/d", "port": "run" },
                { "from": "W/e", "to": "W/f", "port": "run" },
                { "from": "W/g", "to": "W/h", "port": "run" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn a_press_runs_the_widgets_logic() {
        let logic = press_logic();
        let mut data = Data::new();
        let mut states = BTreeMap::new();
        for _ in 0..2 {
            let (set, _) = press(&logic, "W", "plus", "", &data, &mut states).unwrap();
            data.extend(set);
        }
        assert_eq!(data["w_W_score"], "2");
        let (set, _) = press(&logic, "W", "undo", "", &data, &mut states).unwrap();
        data.extend(set);
        assert_eq!(data["w_W_score"], "1");
        let (set, _) = press(&logic, "W", "set", "7", &data, &mut states).unwrap();
        data.extend(set);
        assert_eq!(data["w_W_score"], "7");
        let (set, fwd) = press(&logic, "W", "go", "", &data, &mut states).unwrap();
        assert!(set.is_empty());
        assert_eq!(fwd.len(), 1);
        assert_eq!(
            (fwd[0].layer.as_str(), fwd[0].op.as_str()),
            ("W/clock", "start")
        );
        assert!(press(&logic, "W", "nope", "", &data, &mut states).is_err());
    }
}
