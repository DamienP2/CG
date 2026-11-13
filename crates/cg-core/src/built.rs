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
#[serde(rename_all = "camelCase")]
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

/// The values of the template's built widgets kept after the graphic has been
/// on air (variables marked to keep), by data key: what its rundown item
/// keeps for the next take.
pub fn kept(defs: &[Def], layers: &[Layer], data: &Data) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for l in layers {
        let Some(def) = l
            .widget
            .as_ref()
            .and_then(|w| defs.iter().find(|d| d.id == w.def))
        else {
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
        let Some(def) = l
            .widget
            .as_ref()
            .and_then(|w| defs.iter().find(|d| d.id == w.def))
        else {
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
        let k = kept(&[d.clone()], &[l.clone()], &data);
        assert!(k.contains_key(&var_key("W", "score_1")));
        assert!(!k.contains_key(&var_key("W", "tir")));
        assert!(!k.contains_key("other"));
        assert_eq!(not_kept(&[d], &[l]), vec![var_key("W", "tir")]);
    }
}
