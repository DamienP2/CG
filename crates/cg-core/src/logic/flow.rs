//! The flows ▶ of a graph, run on air by the server on each tick.
//!
//! A flow starts from an event, a trigger, Continue, the take, a timer
//! (« Every »), a branch of an If that becomes the one chosen, or a value
//! wired into a flow input that becomes true. It goes from node to node
//! through the flow wires: waits, counts, chooses a branch, and asks for
//! actions ([`Act`]), which the playout does.
//!
//! What a flow remembers (a wait, a counter, what was seen last) is kept
//! in the graphic's `watch`, under `fl:` keys; what the renderers read (a
//! counter) in its `vals`.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::{
    count_key, event_key, expr, format_number, Cx, Graph, LVal, Logic, NodeKind, TextMetric, Values,
};
use crate::anim::Data;
use crate::model::{Prop, Value};

/// What a flow asks of the playout.
#[derive(Debug, Clone, PartialEq)]
pub enum Act {
    Out,
    Resume(String),
    Fire(String),
    NextRow(String),
    SetVar {
        name: String,
        value: String,
        transition: f64,
    },
    Take(String),
    TakeOut(String),
    Widget {
        layer: String,
        control: String,
    },
}

/// The moment: the data the graphic shows (with what the server saw:
/// events, variables), seconds since it was taken, the clock.
pub struct Tick<'a> {
    pub data: &'a Data,
    pub secs: f64,
    pub now_ms: i64,
}

const MAX_STEPS: usize = 512;

/// Runs the flows of `logic` for this tick; returns the actions asked.
pub fn run(
    logic: &Logic,
    tick: &Tick,
    watch: &mut BTreeMap<String, String>,
    vals: &mut BTreeMap<String, String>,
) -> Vec<Act> {
    let g = Graph::new(logic);
    let values = Values::new();
    let mut measure = |_: &str, _: &BTreeMap<Prop, Value>, _: TextMetric| 0.0;
    // The data, with the counters as they go during this tick.
    let mut local: Data = tick.data.clone();
    let clock = expr::Clock {
        secs: tick.secs,
        now_ms: tick.now_ms,
    };
    macro_rules! cx {
        () => {
            &mut Cx {
                values: &values,
                data: &local,
                measure: &mut measure,
                clock,
            }
        };
    }
    // (node, input port) to run.
    let mut queue: VecDeque<(String, String)> = VecDeque::new();
    let fire = |queue: &mut VecDeque<(String, String)>, node: &str, port: &str| {
        for e in &logic.edges {
            if e.from == node && e.from_port == port {
                if let Some(to) = g.nodes.get(e.to.as_str()) {
                    if to.kind.flow_inputs().contains(&e.port.as_str()) {
                        queue.push_back((e.to.clone(), e.port.clone()));
                    }
                }
            }
        }
    };
    let has_flow_out: BTreeSet<(&str, &str)> = logic
        .edges
        .iter()
        .map(|e| (e.from.as_str(), e.from_port.as_str()))
        .collect();
    let rising = |watch: &mut BTreeMap<String, String>, key: String, now: bool| {
        let was = watch.get(&key).is_some_and(|v| v == "1");
        if now != was {
            watch.insert(key, if now { "1" } else { "0" }.into());
        }
        now && !was
    };

    // What starts a flow now.
    for n in &logic.nodes {
        if !g.acts(&n.id) {
            continue;
        }
        let id = n.id.as_str();
        match &n.kind {
            NodeKind::Event { .. } | NodeKind::TriggerIn { .. } | NodeKind::Continue {} => {
                let now = tick.data.get(&event_key(id)).is_some_and(|v| v == "1");
                if rising(watch, format!("fl:lv:{id}"), now) {
                    fire(&mut queue, id, "out");
                }
            }
            NodeKind::Start {} => {
                let k = format!("fl:start:{id}");
                if let std::collections::btree_map::Entry::Vacant(e) = watch.entry(k) {
                    e.insert("1".into());
                    fire(&mut queue, id, "out");
                }
            }
            NodeKind::Every { seconds } if *seconds > 0.0 => {
                let k = format!("fl:every:{id}");
                let last = watch
                    .get(&k)
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                if tick.secs - last >= *seconds {
                    watch.insert(k, format!("{}", tick.secs));
                    fire(&mut queue, id, "out");
                }
            }
            NodeKind::Wait { .. } => {
                let k = format!("fl:wait:{id}");
                if let Some(due) = watch.get(&k).and_then(|v| v.parse::<f64>().ok()) {
                    if tick.secs >= due {
                        watch.remove(&k);
                        fire(&mut queue, id, "next");
                    }
                }
            }
            // An If run by nothing: a branch goes when it becomes the one chosen.
            NodeKind::If { branches, .. } if !g.inputs.contains_key(&(id, "run")) => {
                let ports = n.kind.flow_outputs();
                if !ports
                    .iter()
                    .any(|p| has_flow_out.contains(&(id, p.as_str())))
                {
                    continue;
                }
                let chosen = g.branch(id, branches, cx!(), 0);
                let port = chosen.map_or("else".to_string(), |i| format!("b{i}"));
                let k = format!("fl:if:{id}");
                if watch.get(&k) != Some(&port) {
                    watch.insert(k, port.clone());
                    fire(&mut queue, id, &port);
                }
            }
            _ => {}
        }
    }
    // A value wired into a flow input: when it becomes true.
    for e in &logic.edges {
        let (Some(from), Some(to)) = (g.nodes.get(e.from.as_str()), g.nodes.get(e.to.as_str()))
        else {
            continue;
        };
        if !to.kind.flow_inputs().contains(&e.port.as_str())
            || from.kind.flow_outputs().contains(&e.from_port)
            || !g.acts(&e.to)
        {
            continue;
        }
        let now = expr::truthy(&g.eval(&e.from, &e.from_port, cx!(), 0));
        if rising(
            watch,
            format!("fl:e:{}.{}>{}.{}", e.from, e.from_port, e.to, e.port),
            now,
        ) {
            queue.push_back((e.to.clone(), e.port.clone()));
        }
    }

    // Through the flow wires.
    let mut acts = Vec::new();
    let mut steps = 0;
    while let Some((id, port)) = queue.pop_front() {
        steps += 1;
        if steps > MAX_STEPS {
            break;
        }
        let Some(n) = g.nodes.get(id.as_str()) else {
            continue;
        };
        if !g.acts(&id) {
            continue;
        }
        let mut act = |a: Act, queue: &mut VecDeque<(String, String)>| {
            acts.push(a);
            fire(queue, &id, "next");
        };
        match &n.kind {
            NodeKind::If { branches, .. } => {
                let chosen = g.branch(&id, branches, cx!(), 0);
                let p = chosen.map_or("else".to_string(), |i| format!("b{i}"));
                fire(&mut queue, &id, &p);
            }
            NodeKind::Wait { seconds } => {
                let s = g
                    .input(&id, "seconds", cx!(), 0)
                    .map_or(*seconds, |v| v.num());
                watch.insert(
                    format!("fl:wait:{id}"),
                    format!("{}", tick.secs + s.max(0.0)),
                );
            }
            NodeKind::Counter { start, step } => {
                let k = count_key(&id);
                let cur = vals
                    .get(&k)
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(*start);
                let next = if port == "reset" { *start } else { cur + step };
                local.insert(k.clone(), format_number(next));
                vals.insert(k, format_number(next));
                fire(&mut queue, &id, "next");
            }
            NodeKind::Once {} => {
                let k = format!("fl:once:{id}");
                if port == "reset" {
                    watch.remove(&k);
                } else if let std::collections::btree_map::Entry::Vacant(e) = watch.entry(k) {
                    e.insert("1".into());
                    fire(&mut queue, &id, "next");
                }
            }
            NodeKind::Out {} => act(Act::Out, &mut queue),
            NodeKind::Resume { marker } => act(Act::Resume(marker.clone()), &mut queue),
            NodeKind::Fire { name } if !name.trim().is_empty() => {
                act(Act::Fire(name.trim().into()), &mut queue)
            }
            NodeKind::NextRow { dataset } => act(Act::NextRow(dataset.clone()), &mut queue),
            NodeKind::SetVar {
                name,
                value,
                transition,
            } if !name.trim().is_empty() => {
                let v = match g.input(&id, "value", cx!(), 0) {
                    Some(v) => expr::text(&v),
                    None => value.clone(),
                };
                act(
                    Act::SetVar {
                        name: name.trim().into(),
                        value: v,
                        transition: *transition,
                    },
                    &mut queue,
                )
            }
            NodeKind::Take { template, out } if !template.is_empty() => act(
                if *out {
                    Act::TakeOut(template.clone())
                } else {
                    Act::Take(template.clone())
                },
                &mut queue,
            ),
            NodeKind::Widget { layer, control } => act(
                Act::Widget {
                    layer: layer.clone(),
                    control: control.clone(),
                },
                &mut queue,
            ),
            _ => fire(&mut queue, &id, "next"),
        }
    }
    acts
}

/// The value of a node's output as a flow sees it (no layers: data only).
pub fn value(logic: &Logic, node: &str, port: &str, data: &Data, secs: f64) -> LVal {
    let g = Graph::new(logic);
    let values = Values::new();
    let mut measure = |_: &str, _: &BTreeMap<Prop, Value>, _: TextMetric| 0.0;
    let mut cx = Cx {
        values: &values,
        data,
        measure: &mut measure,
        clock: expr::Clock { secs, now_ms: 0 },
    };
    g.eval(node, port, &mut cx, 0)
}
