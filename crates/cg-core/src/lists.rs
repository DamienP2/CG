//! Lists: a folder's children drawn once per row of a list held in the data
//! (`Layer::list`), laid side by side, one under the other or in a grid, and
//! going by in the folder's box (`Layer::roll`). The template's layers are
//! expanded before they are drawn (mirror of `web/src/engine/lists.ts`).

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::anim::{binding_value, default_value, Data};
use crate::model::{
    Layer, LayerKind, ListLayout, Motion, MotionAxis, MotionKind, Prop, Roll, RollBy, RollDir,
    RollMode, RowTest, RowTestKind, Value,
};

/// The end of the id of a list folder's roll group: `<folder id>~roll`.
pub const ROLL_SUFFIX: &str = "~roll";

/// How long a step takes to slide to the next page, seconds.
pub const STEP_SLIDE: f64 = 0.6;

/// At most this many times the rows are laid along a continuous roll.
const MAX_REPEATS: usize = 1000;

/// The column of the rows of a list given as lines of text.
pub const TEXT_COLUMN: &str = "texte";

/// One row of a list: its values by column.
pub type Row = BTreeMap<String, String>;

/// The rows of a list value (a JSON array of objects) that are on, in order.
/// A row whose `on` is `false` is left out; values that are not strings are
/// their JSON text. Not a JSON array: one row per line that is not empty
/// (trimmed), in the column `texte`. Missing: no rows.
/// A list folder's rows: from the data under its key, else its own; their
/// values filled from the data (a row's `{{q1}}` shows the value `q1`).
pub fn list_rows(list: &crate::ListRepeat, data: &Data) -> Vec<Row> {
    let mut out = match data.get(&list.key).filter(|_| !list.key.is_empty()) {
        Some(v) => rows(Some(v)),
        None => list
            .rows
            .iter()
            .filter(|r| r.get("on").map(String::as_str) != Some("false"))
            .cloned()
            .collect(),
    };
    for r in &mut out {
        for v in r.values_mut() {
            if v.contains("{{") {
                *v = crate::anim::interpolate_text(v, data);
            }
        }
    }
    out
}

pub fn rows(value: Option<&str>) -> Vec<Row> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(value)
    else {
        return value
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| Row::from([(TEXT_COLUMN.to_string(), l.to_string())]))
            .collect();
    };
    items
        .into_iter()
        .filter_map(|item| match item {
            serde_json::Value::Object(o) => Some(o),
            _ => None,
        })
        .filter(|o| {
            !matches!(o.get("on"), Some(serde_json::Value::Bool(false)))
                && o.get("on").and_then(serde_json::Value::as_str) != Some("false")
        })
        .map(|o| o.into_iter().map(|(k, v)| (k, as_text(v))).collect())
        .collect()
}

/// A value of a row as text: a string as it is, anything else its JSON
/// text as JavaScript writes it (`1.0` → `1`).
fn as_text(v: serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => {
                format!("{:.0}", f + 0.0)
            }
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

/// The layers with each list folder's children repeated once per row of its
/// list (`data[list.key]`), and its roll group when its rows go by; `None`
/// when no folder has a list. `measure(layer, text)`: the width of `text` on
/// one line in the layer's font, px.
pub fn expand(
    layers: &[Layer],
    data: &Data,
    measure: &mut dyn FnMut(&Layer, &str) -> f64,
) -> Option<Vec<Layer>> {
    let by_id: HashMap<&str, usize> = layers
        .iter()
        .enumerate()
        .rev()
        .map(|(i, l)| (l.id.as_str(), i))
        .collect();
    let mut kids: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, l) in layers.iter().enumerate() {
        if let Some(p) = l.parent.as_deref() {
            kids.entry(p).or_default().push(i);
        }
    }
    // The list folders, those inside another one's subtree aside.
    let folders: Vec<usize> = layers
        .iter()
        .enumerate()
        .filter(|(_, l)| is_list(l) && !in_a_list(layers, &by_id, l))
        .map(|(i, _)| i)
        .collect();
    if folders.is_empty() {
        return None;
    }
    let mut gone = vec![false; layers.len()];
    // What replaces a folder, its roll group, and the copies, by index.
    let mut folder_as: HashMap<usize, Layer> = HashMap::new();
    let mut roll_of: HashMap<usize, Layer> = HashMap::new();
    let mut copies_at: HashMap<usize, Vec<Layer>> = HashMap::new();
    for gi in folders {
        let g = &layers[gi];
        let inside = descendants(&kids, gi, layers);
        for &m in &inside {
            gone[m] = true;
        }
        let model: Vec<&Layer> = inside.iter().map(|&m| &layers[m]).collect();
        let (folder, roll, copies) = expand_folder(g, &model, data, measure);
        folder_as.insert(gi, folder);
        if let Some(r) = roll {
            roll_of.insert(gi, r);
        }
        // Where the first of them was.
        if let Some(&at) = inside.first() {
            copies_at.insert(at, copies);
        }
    }
    let mut out = Vec::with_capacity(layers.len());
    for (i, l) in layers.iter().enumerate() {
        if let Some(c) = copies_at.remove(&i) {
            out.extend(c);
        }
        if gone[i] {
            continue;
        }
        out.push(folder_as.remove(&i).unwrap_or_else(|| l.clone()));
        if let Some(r) = roll_of.remove(&i) {
            out.push(r);
        }
    }
    Some(out)
}

/// A folder with a list.
fn is_list(l: &Layer) -> bool {
    matches!(l.kind, LayerKind::Group { .. }) && l.list.is_some()
}

/// One of the folders `l` is in has a list.
fn in_a_list(layers: &[Layer], by_id: &HashMap<&str, usize>, l: &Layer) -> bool {
    let mut at = l.parent.as_deref();
    for _ in 0..64 {
        let Some(p) = at.and_then(|id| by_id.get(id)).map(|&i| &layers[i]) else {
            return false;
        };
        if is_list(p) {
            return true;
        }
        at = p.parent.as_deref();
    }
    false
}

/// Every layer under the folder at `gi`, in layer order.
fn descendants(kids: &HashMap<&str, Vec<usize>>, gi: usize, layers: &[Layer]) -> Vec<usize> {
    let mut seen: HashSet<usize> = HashSet::from([gi]);
    let mut stack = vec![gi];
    let mut out = Vec::new();
    while let Some(i) = stack.pop() {
        for &k in kids.get(layers[i].id.as_str()).into_iter().flatten() {
            if seen.insert(k) {
                out.push(k);
                stack.push(k);
            }
        }
    }
    out.sort_unstable();
    out
}

/// Not a folder: what the extents of the copies are measured on.
fn flat(l: &Layer) -> bool {
    !matches!(l.kind, LayerKind::Group { .. })
}

/// A set number of a layer (0 when unset).
fn num(l: &Layer, p: Prop) -> f64 {
    l.props.get(&p).and_then(Value::as_number).unwrap_or(0.0)
}

/// A number of a layer as drawn when not animated (its default when unset).
fn drawn(l: &Layer, p: Prop) -> f64 {
    l.props
        .get(&p)
        .copied()
        .unwrap_or_else(|| default_value(p))
        .as_number()
        .unwrap_or(0.0)
}

/// The row passes the test (a missing column is empty).
fn passes(w: &RowTest, row: &Row) -> bool {
    let v = row.get(&w.col).map_or("", String::as_str);
    match w.test {
        RowTestKind::Filled => !v.trim().is_empty(),
        RowTestKind::Empty => v.trim().is_empty(),
        RowTestKind::Is => w.value.as_deref() == Some(v),
        RowTestKind::IsNot => w.value.as_deref() != Some(v),
    }
}

/// `text` with its `{{ col }}` of the row's columns replaced by the row's
/// values; other placeholders stay.
pub fn fill_in(text: &str, row: &Row) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        match row.get(after[..end].trim()) {
            Some(v) => out.push_str(v),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// A property by its JSON name (`fill`).
fn prop_named(name: &str) -> Option<Prop> {
    serde_json::from_value(serde_json::Value::String(name.to_string())).ok()
}

/// The copy takes the row's values: in its text or picture, in the
/// properties bound to a column, in the colours chosen by a column.
fn take_row(c: &mut Layer, row: &Row) {
    match &mut c.kind {
        LayerKind::Text { text, .. } => *text = fill_in(text, row),
        LayerKind::Image { src, .. } => *src = fill_in(src, row),
        _ => {}
    }
    let bound: Vec<(Prop, String)> = c
        .bindings
        .iter()
        .filter(|(_, k)| row.contains_key(k.as_str()))
        .map(|(p, k)| (*p, k.clone()))
        .collect();
    for (p, k) in bound {
        c.bindings.remove(&p);
        if let Some(v) = binding_value(p, &row[&k]) {
            c.props.insert(p, v);
        }
    }
    let colors = c
        .in_list
        .as_ref()
        .map(|x| x.colors.clone())
        .unwrap_or_default();
    for rc in colors {
        let v = row.get(&rc.col).map_or("", String::as_str);
        let (Some(p), Some(hex)) = (prop_named(&rc.prop), rc.map.get(v)) else {
            continue;
        };
        if let Some(v) = binding_value(p, hex) {
            c.props.insert(p, v);
        }
    }
}

/// The copies of the model for row `i` (those its tests keep, in folders
/// kept), not laid yet.
fn copies_of_row(g: &Layer, model: &[&Layer], row: &Row, i: usize, top: &str) -> Vec<Layer> {
    let by_id: HashMap<&str, &Layer> = model.iter().map(|m| (m.id.as_str(), *m)).collect();
    let shown = |l: &Layer| {
        l.in_list
            .as_ref()
            .and_then(|x| x.when.as_ref())
            .is_none_or(|w| passes(w, row))
    };
    // It, or one of its folders in the list folder, is not shown for the row.
    let hidden = |m: &Layer| {
        let mut at = Some(m);
        for _ in 0..64 {
            let Some(l) = at else {
                return false;
            };
            if !shown(l) {
                return true;
            }
            at = l
                .parent
                .as_deref()
                .filter(|p| *p != g.id)
                .and_then(|p| by_id.get(p).copied());
        }
        false
    };
    let mut out = Vec::new();
    for m in model.iter().filter(|m| !hidden(m)) {
        let mut c = (*m).clone();
        c.id = format!("{}#{i}", m.id);
        c.parent = Some(match m.parent.as_deref() {
            Some(p) if p != g.id => format!("{p}#{i}"),
            _ => top.to_string(),
        });
        take_row(&mut c, row);
        out.push(c);
    }
    out
}

/// Moves a layer by `dx`, `dy`: its position and its position's keyframes.
fn shift(l: &mut Layer, dx: f64, dy: f64) {
    for (p, d) in [(Prop::X, dx), (Prop::Y, dy)] {
        if d == 0.0 {
            continue;
        }
        let v = num(l, p);
        l.props.insert(p, Value::Number(v + d));
        for k in l.tracks.get_mut(&p).into_iter().flatten() {
            if let Value::Number(n) = &mut k.value {
                *n += d;
            }
        }
    }
}

/// The copies of a row moved by (`dx`, `dy`): those directly in the folder
/// (the others move with them).
fn lay(copies: &mut [Layer], top: &str, dx: f64, dy: f64) {
    for c in copies.iter_mut() {
        if c.parent.as_deref() == Some(top) {
            shift(c, dx, dy);
        }
    }
}

/// The copies again under other ids (`<id>@<tag>`), moved by (`dx`, `dy`).
fn again(copies: &[Layer], top: &str, tag: &str, dx: f64, dy: f64) -> Vec<Layer> {
    let mut out: Vec<Layer> = copies
        .iter()
        .map(|c| {
            let mut c = c.clone();
            c.id = format!("{}@{tag}", c.id);
            if let Some(p) = c.parent.as_mut().filter(|p| p.as_str() != top) {
                p.push('@');
                p.push_str(tag);
            }
            c
        })
        .collect();
    lay(&mut out, top, dx, dy);
    out
}

/// The size of a grid's cell: the largest copy, from `origin` (sizes as set).
fn cell(made: &[Vec<Layer>], origin: (f64, f64)) -> (f64, f64) {
    let far = |p: Prop, size: Prop, from: f64| {
        made.iter()
            .filter_map(|c| {
                c.iter()
                    .filter(|l| flat(l))
                    .map(|l| num(l, p) + num(l, size))
                    .reduce(f64::max)
                    .map(|end| end - from)
            })
            .reduce(f64::max)
            .unwrap_or(0.0)
    };
    (
        far(Prop::X, Prop::Width, origin.0),
        far(Prop::Y, Prop::Height, origin.1),
    )
}

/// How far each row's copies go from `origin` along x (a row: a text as
/// wide as its text measured) or along y (a column).
fn extents(
    made: &[Vec<Layer>],
    column: bool,
    origin: (f64, f64),
    measure: &mut dyn FnMut(&Layer, &str) -> f64,
) -> Vec<f64> {
    made.iter()
        .map(|c| {
            c.iter()
                .filter(|l| flat(l))
                .map(|l| {
                    if column {
                        return num(l, Prop::Y) + num(l, Prop::Height);
                    }
                    let w = match &l.kind {
                        LayerKind::Text { text, .. } if text.is_empty() => 0.0,
                        LayerKind::Text { text, .. } => measure(l, text),
                        _ => num(l, Prop::Width),
                    };
                    num(l, Prop::X) + w
                })
                .reduce(f64::max)
                .map_or(0.0, |end| end - if column { origin.1 } else { origin.0 })
        })
        .collect()
}

/// The folder (clipping when its rows go by), its roll group, and the
/// copies of its children laid for each row.
fn expand_folder(
    g: &Layer,
    model: &[&Layer],
    data: &Data,
    measure: &mut dyn FnMut(&Layer, &str) -> f64,
) -> (Layer, Option<Layer>, Vec<Layer>) {
    let list = g.list.as_ref().expect("a list folder");
    let rows = list_rows(list, data);
    let roll = g.roll.as_ref();
    let top = match roll {
        Some(_) => format!("{}{ROLL_SUFFIX}", g.id),
        None => g.id.clone(),
    };
    let mut made: Vec<Vec<Layer>> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| copies_of_row(g, model, row, i, &top))
        .collect();
    let min_of = |p: Prop| {
        model
            .iter()
            .filter(|l| flat(l))
            .map(|l| num(l, p))
            .reduce(f64::min)
            .unwrap_or(0.0)
    };
    let origin = (min_of(Prop::X), min_of(Prop::Y));
    let cols = list.cols.unwrap_or(3).max(1) as usize;
    let gap = list.gap;
    // Where each row's copies go, and where the last one ends along the
    // layout's axis (the grid: along the roll's).
    let flow = |made: &[Vec<Layer>], measure: &mut dyn FnMut(&Layer, &str) -> f64| {
        if list.layout == ListLayout::Grid {
            let (cw, ch) = cell(made, origin);
            let offs: Vec<(f64, f64)> = (0..made.len())
                .map(|i| {
                    (
                        (i % cols) as f64 * (cw + gap),
                        (i / cols) as f64 * (ch + gap),
                    )
                })
                .collect();
            let up = roll.is_some_and(|r| r.dir == RollDir::Up);
            let total = offs
                .iter()
                .map(|(dx, dy)| if up { dy + ch } else { dx + cw })
                .reduce(f64::max)
                .unwrap_or(0.0);
            return (offs, total);
        }
        let column = list.layout == ListLayout::Column;
        let ext = extents(made, column, origin, measure);
        let mut offs = Vec::with_capacity(ext.len());
        let mut off = 0.0;
        for e in &ext {
            offs.push(if column { (0.0, off) } else { (off, 0.0) });
            off += e + gap;
        }
        let total = match (offs.last(), ext.last()) {
            (Some(&(x, y)), Some(e)) => (if column { y } else { x }) + e,
            _ => 0.0,
        };
        (offs, total)
    };
    let mut folder = g.clone();
    let Some(roll) = roll else {
        let (offs, _) = flow(&made, measure);
        for (c, (dx, dy)) in made.iter_mut().zip(offs) {
            lay(c, &top, dx, dy);
        }
        return (folder, None, made.into_iter().flatten().collect());
    };
    // Rows going by: the folder clips, a group in its box carries them.
    if let LayerKind::Group { clip, .. } = &mut folder.kind {
        *clip = true;
    }
    let (box_w, box_h) = (drawn(g, Prop::Width), drawn(g, Prop::Height));
    let (axis, box_len) = match roll.dir {
        RollDir::Left => (MotionAxis::X, box_w),
        RollDir::Up => (MotionAxis::Y, box_h),
    };
    let n = made.len();
    let (copies, motion) = match roll.mode {
        RollMode::Continuous => {
            let (offs, total) = flow(&made, measure);
            for (c, (dx, dy)) in made.iter_mut().zip(offs) {
                lay(c, &top, dx, dy);
            }
            let laid: Vec<Layer> = made.into_iter().flatten().collect();
            continuous(roll, laid, n, &top, total, gap, box_len, axis)
        }
        RollMode::One => {
            // The page of each row, and its place in the page.
            let (places, steps): (Vec<(usize, f64, f64)>, usize) = match list.layout {
                ListLayout::Grid => {
                    let (cw, ch) = cell(&made, origin);
                    let fit = |len: f64, size: f64| {
                        let k = ((len + gap) / (size + gap)).floor();
                        if k.is_finite() && k >= 1.0 {
                            k as usize
                        } else {
                            1
                        }
                    };
                    // Copies across and down a page.
                    let (across, down) = match roll.dir {
                        RollDir::Up => (cols, fit(box_h, ch)),
                        RollDir::Left => (fit(box_w, cw), fit(box_h, ch)),
                    };
                    let per_page = across * down;
                    let places = (0..n)
                        .map(|i| {
                            let j = i % per_page;
                            (
                                i / per_page,
                                (j % across) as f64 * (cw + gap),
                                (j / across) as f64 * (ch + gap),
                            )
                        })
                        .collect();
                    (places, n.div_ceil(per_page))
                }
                _ => ((0..n).map(|i| (i, 0.0, 0.0)).collect(), n),
            };
            let along = |d: f64| match axis {
                MotionAxis::X => (d, 0.0),
                MotionAxis::Y => (0.0, d),
            };
            // Page 0 again after the last one, for the last step to come round.
            let wrap = steps >= 2;
            let (wx, wy) = along(steps as f64 * box_len);
            let mut out = Vec::new();
            let mut again_first = Vec::new();
            for (mut c, (page, dx, dy)) in made.into_iter().zip(places) {
                if wrap && page == 0 {
                    again_first.extend(again(&c, &top, "w", wx + dx, wy + dy));
                }
                let (px, py) = along(page as f64 * box_len);
                lay(&mut c, &top, px + dx, py + dy);
                out.extend(c);
            }
            out.extend(again_first);
            let motion = wrap.then(|| Motion {
                axis,
                distance: box_len,
                steps: steps as u32,
                pause: roll.pause,
                ..Motion::new(MotionKind::Step, roll.pause + STEP_SLIDE)
            });
            (out, motion)
        }
    };
    let r = roll_group(g, &top, motion);
    (folder, Some(r), copies)
}

/// A continuous roll: the rows laid (`total` px long along the axis) again
/// as many times as the box needs (by speed), and the crawl moving them.
#[allow(clippy::too_many_arguments)]
fn continuous(
    roll: &Roll,
    laid: Vec<Layer>,
    rows: usize,
    top: &str,
    total: f64,
    gap: f64,
    box_len: f64,
    axis: MotionAxis,
) -> (Vec<Layer>, Option<Motion>) {
    let crawl = |distance: f64, period: f64, once: bool| Motion {
        axis,
        distance,
        lead: box_len,
        once,
        ..Motion::new(MotionKind::Crawl, period)
    };
    match roll.by {
        RollBy::Speed => {
            let len = total + gap;
            if rows == 0 || len <= 0.0 || roll.speed <= 0.0 {
                return (laid, None);
            }
            let k = (((box_len / len).ceil().max(0.0) as usize) + 1).min(MAX_REPEATS);
            let mut out = laid.clone();
            for r in 1..k {
                let d = r as f64 * len;
                let (dx, dy) = match axis {
                    MotionAxis::X => (d, 0.0),
                    MotionAxis::Y => (0.0, d),
                };
                out.extend(again(&laid, top, &r.to_string(), dx, dy));
            }
            (out, Some(crawl(len, len / roll.speed, false)))
        }
        RollBy::Duration => {
            if rows == 0 || total <= 0.0 || roll.duration <= 0.0 {
                return (laid, None);
            }
            let speed = (box_len + total) / roll.duration;
            (laid, Some(crawl(total, total / speed, true)))
        }
    }
}

/// The group carrying a list folder's rows in its box (`<folder>~roll`): in
/// the folder, at its top left, as big; on the folder's clock.
fn roll_group(g: &Layer, id: &str, motion: Option<Motion>) -> Layer {
    let mut props = BTreeMap::from([(Prop::X, Value::Number(0.0)), (Prop::Y, Value::Number(0.0))]);
    for p in [Prop::Width, Prop::Height] {
        if let Some(v) = g.props.get(&p) {
            props.insert(p, *v);
        }
    }
    Layer {
        id: id.to_string(),
        name: g.name.clone(),
        parent: Some(g.id.clone()),
        kind: LayerKind::Group {
            clip: false,
            lottie: None,
            mask: None,
        },
        visible: true,
        locked: false,
        manual_start: g.manual_start,
        start_on: None,
        start_trigger: String::new(),
        scale_lock: false,
        lock_ratio: false,
        drop_shadow: false,
        timeline: None,
        props,
        tracks: BTreeMap::new(),
        bindings: BTreeMap::new(),
        setting_bindings: BTreeMap::new(),
        overrides: BTreeMap::new(),
        live_changes: BTreeMap::new(),
        span: None,
        motion,
        anchor: None,
        widget: None,
        lit: None,
        list: None,
        roll: None,
        in_list: None,
    }
}

/// The id of the folder whose clock a layer follows: a roll group's, its
/// folder's.
pub fn clock_id(id: &str) -> &str {
    id.strip_suffix(ROLL_SUFFIX).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Color;

    /// The shared test vectors' template (lists spec §6).
    fn template(extra: serde_json::Value) -> Vec<Layer> {
        let mut g = serde_json::json!({
            "id": "G", "name": "List", "type": "group",
            "props": {"x": 100.0, "y": 500.0, "width": 600.0, "height": 60.0},
            "list": {"key": "L", "layout": "row", "gap": 20.0}
        });
        for (k, v) in extra.as_object().expect("an object") {
            g[k] = v.clone();
        }
        serde_json::from_value(serde_json::json!([
            g,
            {"id": "cat", "name": "Cat", "type": "rect", "parent": "G",
             "props": {"x": 100.0, "y": 510.0, "width": 80.0, "height": 40.0},
             "inList": {
                "when": {"col": "cat", "test": "filled"},
                "colors": [{"prop": "fill", "col": "cat", "map": {"Sport": "#ff0000"}}]
             }},
            {"id": "txt", "name": "Txt", "type": "text", "parent": "G", "text": "{{texte}}",
             "fontFamily": "Inter",
             "props": {"x": 200.0, "y": 510.0, "width": 300.0, "height": 40.0}}
        ]))
        .expect("layers")
    }

    fn data() -> Data {
        Data::from([(
            "L".to_string(),
            r#"[{"texte":"Abc","cat":"Sport"},{"texte":"Hello","cat":""},{"texte":"Zz","on":false}]"#
                .to_string(),
        )])
    }

    /// 10 px per character.
    fn ten(_: &Layer, t: &str) -> f64 {
        t.chars().count() as f64 * 10.0
    }

    fn ids(layers: &[Layer]) -> Vec<&str> {
        layers.iter().map(|l| l.id.as_str()).collect()
    }

    fn get<'a>(layers: &'a [Layer], id: &str) -> &'a Layer {
        layers.iter().find(|l| l.id == id).expect(id)
    }

    fn text(l: &Layer) -> &str {
        match &l.kind {
            LayerKind::Text { text, .. } => text,
            _ => panic!("not a text"),
        }
    }

    #[test]
    fn rows_are_the_rows_that_are_on() {
        let r = rows(Some(
            r#"[{"a":"x","n":3,"b":true},{"a":"y","on":"false"},{"a":"z","on":true},7]"#,
        ));
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["n"], "3");
        assert_eq!(rows(Some(r#"[{"n":1.0,"m":2.5}]"#))[0]["n"], "1");
        assert_eq!(rows(Some(r#"[{"n":1.0,"m":2.5}]"#))[0]["m"], "2.5");
        assert_eq!(r[0]["b"], "true");
        assert_eq!(r[1]["a"], "z");
        assert!(rows(None).is_empty());
        assert!(rows(Some("")).is_empty());
        assert!(rows(Some("[]")).is_empty());
        // Not a JSON array: one row per line that is not empty.
        let lines = rows(Some("Abc\n\n  Hello "));
        assert_eq!(
            lines,
            vec![
                Row::from([("texte".to_string(), "Abc".to_string())]),
                Row::from([("texte".to_string(), "Hello".to_string())]),
            ]
        );
        assert_eq!(rows(Some(r#"{"a":1}"#))[0]["texte"], r#"{"a":1}"#);
    }

    #[test]
    fn placeholders_of_other_names_stay() {
        let row = Row::from([("a".to_string(), "1".to_string())]);
        assert_eq!(fill_in("{{ a }}-{{b}}-{{a}}", &row), "1-{{b}}-1");
        assert_eq!(fill_in("open {{ a", &row), "open {{ a");
    }

    #[test]
    fn without_a_list_nothing_changes() {
        let mut layers = template(serde_json::json!({}));
        layers[0].list = None;
        assert!(expand(&layers, &data(), &mut ten).is_none());
    }

    #[test]
    fn the_rows_are_laid_side_by_side() {
        // Vector 1.
        let out = expand(&template(serde_json::json!({})), &data(), &mut ten).unwrap();
        assert_eq!(ids(&out), ["G", "cat#0", "txt#0", "txt#1"]);
        let cat = get(&out, "cat#0");
        assert_eq!(cat.props[&Prop::X], Value::Number(100.0));
        assert_eq!(
            cat.props[&Prop::Fill],
            Value::Color(Color::from_hex("#ff0000").unwrap())
        );
        assert_eq!(cat.parent.as_deref(), Some("G"));
        assert_eq!(text(get(&out, "txt#0")), "Abc");
        assert_eq!(get(&out, "txt#0").props[&Prop::X], Value::Number(200.0));
        assert_eq!(text(get(&out, "txt#1")), "Hello");
        assert_eq!(get(&out, "txt#1").props[&Prop::X], Value::Number(350.0));
        assert!(matches!(out[0].kind, LayerKind::Group { clip: false, .. }));
    }

    #[test]
    fn rows_going_by_at_a_speed_are_laid_again() {
        // Vector 2.
        let roll = serde_json::json!({"roll": {"mode": "continuous", "dir": "left", "by": "speed", "speed": 100.0}});
        let out = expand(&template(roll), &data(), &mut ten).unwrap();
        assert_eq!(
            ids(&out),
            [
                "G", "G~roll", "cat#0", "txt#0", "txt#1", "cat#0@1", "txt#0@1", "txt#1@1",
                "cat#0@2", "txt#0@2", "txt#1@2"
            ]
        );
        assert!(matches!(out[0].kind, LayerKind::Group { clip: true, .. }));
        let r = &out[1];
        assert_eq!(r.name, "List");
        assert_eq!(r.parent.as_deref(), Some("G"));
        assert!(matches!(r.kind, LayerKind::Group { clip: false, .. }));
        assert_eq!(r.props[&Prop::Width], Value::Number(600.0));
        assert_eq!(r.props[&Prop::Height], Value::Number(60.0));
        let m = r.motion.expect("a crawl");
        assert_eq!(m.kind, MotionKind::Crawl);
        assert_eq!(m.axis, MotionAxis::X);
        assert_eq!((m.distance, m.lead, m.period), (320.0, 600.0, 3.2));
        assert_eq!((m.from, m.once), (0.0, false));
        for l in &out[2..] {
            assert_eq!(l.parent.as_deref(), Some("G~roll"));
        }
        let x = |id: &str| get(&out, id).props[&Prop::X];
        assert_eq!(x("txt#1"), Value::Number(350.0));
        assert_eq!(x("cat#0@1"), Value::Number(420.0));
        assert_eq!(x("txt#1@1"), Value::Number(670.0));
        assert_eq!(x("txt#1@2"), Value::Number(990.0));
    }

    #[test]
    fn rows_going_up_over_a_duration_go_once() {
        // Vector 3.
        let extra = serde_json::json!({
            "list": {"key": "L", "layout": "column", "gap": 20.0},
            "roll": {"mode": "continuous", "dir": "up", "by": "duration", "duration": 10.0}
        });
        let mut measured = 0;
        let out = expand(&template(extra), &data(), &mut |l: &Layer, t: &str| {
            measured += 1;
            ten(l, t)
        })
        .unwrap();
        assert_eq!(measured, 0, "a column is not measured");
        assert_eq!(ids(&out), ["G", "G~roll", "cat#0", "txt#0", "txt#1"]);
        assert_eq!(get(&out, "txt#1").props[&Prop::Y], Value::Number(570.0));
        let m = out[1].motion.expect("a crawl");
        assert_eq!(m.axis, MotionAxis::Y);
        assert_eq!(
            (m.distance, m.lead, m.period, m.once),
            (100.0, 60.0, 6.25, true)
        );
    }

    #[test]
    fn one_page_at_a_time_comes_round_to_the_first() {
        let extra = serde_json::json!({"roll": {"mode": "one", "dir": "left", "pause": 3.0}});
        let out = expand(&template(extra), &data(), &mut ten).unwrap();
        assert_eq!(
            ids(&out),
            ["G", "G~roll", "cat#0", "txt#0", "txt#1", "cat#0@w", "txt#0@w"]
        );
        let x = |id: &str| get(&out, id).props[&Prop::X];
        assert_eq!(x("txt#1"), Value::Number(800.0));
        assert_eq!(x("cat#0@w"), Value::Number(1300.0));
        assert_eq!(x("txt#0@w"), Value::Number(1400.0));
        let m = out[1].motion.expect("a step");
        assert_eq!(m.kind, MotionKind::Step);
        assert_eq!(
            (m.distance, m.steps, m.pause, m.period),
            (600.0, 2, 3.0, 3.6)
        );
        // One page: no step.
        let one = Data::from([("L".to_string(), "Seul".to_string())]);
        let extra = serde_json::json!({"roll": {"mode": "one", "dir": "up"}});
        let out = expand(&template(extra), &one, &mut ten).unwrap();
        assert_eq!(ids(&out), ["G", "G~roll", "txt#0"]);
        assert_eq!(text(&out[2]), "Seul");
        assert!(out[1].motion.is_none());
    }

    #[test]
    fn a_grid_of_pages_going_up() {
        // Cells of 400 × 40 (the text's box as set), 2 across; a box of 60
        // px holds one line of them: 2 a page.
        let extra = serde_json::json!({
            "list": {"key": "L", "layout": "grid", "cols": 2, "gap": 10.0},
            "roll": {"mode": "one", "dir": "up"}
        });
        let d = Data::from([("L".to_string(), "a\nb\nc".to_string())]);
        let out = expand(&template(extra), &d, &mut ten).unwrap();
        let at = |id: &str| {
            let l = get(&out, id);
            (l.props[&Prop::X], l.props[&Prop::Y])
        };
        let n = Value::Number;
        assert_eq!(at("txt#0"), (n(200.0), n(510.0)));
        assert_eq!(at("txt#1"), (n(610.0), n(510.0)));
        assert_eq!(at("txt#2"), (n(200.0), n(570.0)));
        assert_eq!(at("txt#0@w"), (n(200.0), n(630.0)));
        assert_eq!(at("txt#1@w"), (n(610.0), n(630.0)));
        assert_eq!(out[1].motion.expect("a step").steps, 2);
    }

    #[test]
    fn copies_take_their_row_in_bindings_folders_and_keyframes() {
        let layers: Vec<Layer> = serde_json::from_value(serde_json::json!([
            {"id": "G", "name": "G", "type": "group", "list": {"key": "L", "layout": "column", "gap": 0.0}},
            {"id": "s", "name": "S", "type": "group", "parent": "G",
             "props": {"x": 0.0, "y": 0.0, "width": 100.0, "height": 30.0},
             "tracks": {"y": [{"frame": 0.0, "value": 10.0}, {"frame": 10.0, "value": 0.0}]}},
            {"id": "b", "name": "B", "type": "rect", "parent": "s",
             "props": {"x": 0.0, "y": 0.0, "width": 50.0, "height": 30.0},
             "bindings": {"width": "w", "fill": "c", "opacity": "other"}},
            {"id": "n", "name": "Inner", "type": "group", "parent": "s", "list": {"key": "M", "layout": "row", "gap": 0.0}},
            {"id": "pic", "name": "Pic", "type": "image", "parent": "n", "src": "/assets/{{ logo }}.png"},
            {"id": "after", "name": "After", "type": "rect"}
        ]))
        .unwrap();
        let d = Data::from([
            (
                "L".to_string(),
                r##"[{"w":"70","c":"#00ff00","logo":"a"},{"w":"x","c":"nope","logo":"b"}]"##
                    .to_string(),
            ),
            ("M".to_string(), "[]".to_string()),
        ]);
        let out = expand(&layers, &d, &mut ten).unwrap();
        assert_eq!(
            ids(&out),
            ["G", "s#0", "b#0", "n#0", "pic#0", "s#1", "b#1", "n#1", "pic#1", "after"]
        );
        // A folder in the list: its copy moves, its children with it.
        let s1 = get(&out, "s#1");
        assert_eq!(s1.props[&Prop::Y], Value::Number(30.0));
        assert_eq!(s1.tracks[&Prop::Y][0].value, Value::Number(40.0));
        assert_eq!(s1.tracks[&Prop::Y][1].value, Value::Number(30.0));
        let b1 = get(&out, "b#1");
        assert_eq!(b1.parent.as_deref(), Some("s#1"));
        assert_eq!(b1.props[&Prop::Y], Value::Number(0.0));
        // Bound to a column: set from the row (when it reads), unbound.
        let b0 = get(&out, "b#0");
        assert_eq!(b0.props[&Prop::Width], Value::Number(70.0));
        assert_eq!(
            b0.props[&Prop::Fill],
            Value::Color(Color::from_hex("#00ff00").unwrap())
        );
        assert_eq!(b0.bindings.len(), 1);
        assert_eq!(b1.props[&Prop::Width], Value::Number(50.0));
        assert!(!b1.props.contains_key(&Prop::Fill));
        assert_eq!(b1.bindings.len(), 1);
        // A list inside a list: copied as it is, not expanded.
        assert!(get(&out, "n#1").list.is_some());
        match &get(&out, "pic#1").kind {
            LayerKind::Image { src, .. } => assert_eq!(src, "/assets/b.png"),
            _ => panic!("an image"),
        }
        assert_eq!(get(&out, "pic#1").parent.as_deref(), Some("n#1"));
    }

    #[test]
    fn a_hidden_folder_hides_its_children_for_the_row() {
        let layers: Vec<Layer> = serde_json::from_value(serde_json::json!([
            {"id": "G", "name": "G", "type": "group", "list": {"key": "L", "layout": "row", "gap": 0.0}},
            {"id": "s", "name": "S", "type": "group", "parent": "G",
             "inList": {"when": {"col": "k", "test": "is", "value": "yes"}}},
            {"id": "b", "name": "B", "type": "rect", "parent": "s"},
            {"id": "c", "name": "C", "type": "rect", "parent": "G",
             "inList": {"when": {"col": "k", "test": "isNot", "value": "yes"}}}
        ]))
        .unwrap();
        let d = Data::from([(
            "L".to_string(),
            r#"[{"k":"yes"},{"k":"no"},{}]"#.to_string(),
        )]);
        let out = expand(&layers, &d, &mut ten).unwrap();
        assert_eq!(ids(&out), ["G", "s#0", "b#0", "c#1", "c#2"]);
        // A child listed before its folder is hidden with it.
        let mut reordered = layers.clone();
        reordered.swap(1, 2);
        let out = expand(&reordered, &d, &mut ten).unwrap();
        assert_eq!(ids(&out), ["G", "b#0", "s#0", "c#1", "c#2"]);
        // No rows: nothing in the folder.
        let out = expand(&layers, &Data::new(), &mut ten).unwrap();
        assert_eq!(ids(&out), ["G"]);
    }

    #[test]
    fn a_roll_group_runs_on_its_folders_clock() {
        assert_eq!(clock_id("G~roll"), "G");
        assert_eq!(clock_id("G"), "G");
    }

    #[test]
    fn a_folders_own_rows_and_values_from_the_data() {
        let list: crate::ListRepeat = serde_json::from_value(serde_json::json!({
            "key": "absent", "layout": "row", "gap": 0,
            "rows": [{ "texte": "{{q1}}", "cat": "{{d1}}" }, { "texte": "off", "on": "false" }]
        }))
        .unwrap();
        let data: Data = [
            ("q1".to_string(), "CAC 40".to_string()),
            ("d1".to_string(), "▲".to_string()),
        ]
        .into();
        let r = list_rows(&list, &data);
        assert_eq!(r.len(), 1);
        assert_eq!(
            (r[0]["texte"].as_str(), r[0]["cat"].as_str()),
            ("CAC 40", "▲")
        );
    }
}
