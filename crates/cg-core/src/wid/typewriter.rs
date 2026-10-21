//! Typewriter: settings, operator state and actions, and the typing
//! timeline both renderers use.
//! Drawn by `cg-render/src/wid/typewriter.rs` and `web/src/widgets/typewriter.tsx` (keep in sync).
//!
//! Time model: everything is a pure function of the elapsed time. Without
//! operator action the typing starts at the take (time on air); the
//! operator's actions keep timestamps (`since`) and a base, never a count.
//! The text at `text` (legacy field, wired by the Data canvas) is the first
//! one; `more` are typed after it (chaining).

use serde::{Deserialize, Serialize};

use super::text::graphemes;
use super::ActCtx;
use crate::anim::interpolate_text;
use crate::model::{Layer, LayerKind};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unit {
    #[default]
    Char,
    Word,
    Line,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeedMode {
    /// `speed` units per second (the layer's older `speed` field).
    #[default]
    Rate,
    /// The whole text in `duration` seconds.
    Duration,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Appear {
    #[default]
    Instant,
    Fade,
    Slide,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Erase {
    #[default]
    Backspace,
    Block,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnEdit {
    #[default]
    Restart,
    Continue,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Item {
    pub text: String,
}

/// Settings of the widget, flattened into the layer's JSON (every field
/// has a default: an older typewriter types as before).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Texts typed after the first one (`text`).
    pub more: Vec<Item>,
    pub unit: Unit,
    pub speed_mode: SpeedMode,
    /// Seconds for the whole text (speed mode `duration`).
    pub duration: f64,
    /// Random variation of each step, % (seeded: same in both renderers).
    pub jitter: f64,
    /// Extra pause after a unit ending with . , ; : ! ? … —, ms.
    pub punct_pause: f64,
    pub appear: Appear,
    pub appear_ms: f64,
    /// "|", "_" or "█".
    pub cursor_ch: String,
    /// Empty = the text colour.
    pub cursor_color: String,
    pub cursor_blink: bool,
    /// The cursor goes once the last text is typed.
    pub cursor_hide: bool,
    pub erase: Erase,
    /// Graphemes per second.
    pub erase_rate: f64,
    /// Seconds a typed text stays before it is erased.
    pub hold: f64,
    pub chain_loop: bool,
    /// Older layers: the layout is now always frozen (the whole text laid
    /// out from the start: no word jumps line); kept so they load.
    pub frozen: bool,
    pub on_edit: OnEdit,
    /// Size chosen once on the complete text so it fits the box.
    pub auto_shrink: bool,
    /// px.
    pub min_size: f32,
    pub line_height: f32,
    pub plate: bool,
    pub plate_color: String,
    /// The plate's bar on the left ("" = none).
    pub plate_accent: String,
    pub shadow: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            more: Vec::new(),
            unit: Unit::Char,
            speed_mode: SpeedMode::Rate,
            duration: 4.0,
            jitter: 0.0,
            punct_pause: 0.0,
            appear: Appear::Instant,
            appear_ms: 220.0,
            cursor_ch: "|".into(),
            cursor_color: String::new(),
            cursor_blink: true,
            cursor_hide: false,
            erase: Erase::Backspace,
            erase_rate: 90.0,
            hold: 1.6,
            chain_loop: false,
            frozen: true,
            on_edit: OnEdit::Restart,
            auto_shrink: false,
            min_size: 30.0,
            line_height: 1.2,
            plate: false,
            plate_color: "#160f33".into(),
            plate_accent: "#ff3b5c".into(),
            shadow: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Types from the take (time on air): no operator action yet.
    #[default]
    Auto,
    Run,
    Paused,
    /// Cleared: nothing typed (the cursor waits).
    Idle,
}

/// What the operator did, as timestamps (computed at draw time, never counted).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub mode: Mode,
    /// Text the run started from.
    pub idx: usize,
    /// Elapsed seconds before `since`.
    pub base: f64,
    /// Wall clock (ms) the run (re)started.
    pub since: Option<i64>,
    /// Elapsed time at which "Show all" was pressed.
    pub all_at: Option<f64>,
}

/// Elapsed seconds of the run.
pub fn elapsed(st: &State, now_ms: i64, age_secs: f64) -> f64 {
    match st.mode {
        Mode::Auto => age_secs.max(0.0),
        Mode::Run => {
            st.base
                + st.since
                    .map_or(0.0, |s| (now_ms - s) as f64 / 1000.0)
                    .max(0.0)
        }
        Mode::Paused | Mode::Idle => st.base,
    }
}

/// Deterministic noise in 0..1 (same integer hash as typewriter.tsx).
pub fn rnd(i: usize, j: usize) -> f64 {
    let mut h: u32 = (i as u32)
        .wrapping_mul(374_761_393)
        .wrapping_add((j as u32).wrapping_mul(668_265_263))
        ^ 0x9e37_79b9;
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    h as f64 / 4_294_967_296.0
}

fn is_punct(s: &str) -> bool {
    s.trim_end()
        .chars()
        .last()
        .is_some_and(|c| ".,;:!?…—".contains(c))
}

fn word_char(g: &str) -> bool {
    g.chars().next().is_some_and(char::is_alphanumeric)
}

/// When each unit of one text appears.
#[derive(Debug, Clone, PartialEq)]
pub struct Timeline {
    pub g: Vec<String>,
    /// Grapheme ranges.
    pub units: Vec<(usize, usize)>,
    /// Seconds each unit appears.
    pub t: Vec<f64>,
    pub unit_of: Vec<usize>,
    /// Appearance of one unit, s.
    pub appear: f64,
    /// Everything typed (and appeared).
    pub type_end: f64,
    pub erase_dur: f64,
}

/// The timeline of `text` (the `idx`-th of the chain). `lines`: visual line
/// of every grapheme in the renderer's frozen layout (unit `line`); without
/// it, lines are the typed line breaks.
pub fn timeline(
    c: &Config,
    rate: f64,
    text: &str,
    idx: usize,
    lines: Option<&[usize]>,
) -> Timeline {
    let g: Vec<String> = graphemes(text).into_iter().map(String::from).collect();
    let n = g.len();
    let mut units: Vec<(usize, usize)> = Vec::new();
    match c.unit {
        Unit::Char => units.extend((0..n).map(|i| (i, i + 1))),
        Unit::Word => {
            // A word and the spaces / punctuation after it.
            let mut start = 0;
            let mut seen = false;
            for i in 0..n {
                let w = word_char(&g[i]);
                if w && seen && (i == 0 || !word_char(&g[i - 1])) {
                    units.push((start, i));
                    start = i;
                }
                seen |= w;
            }
            if n > start {
                units.push((start, n));
            }
        }
        Unit::Line => {
            let line_of = |i: usize| -> usize {
                match lines {
                    Some(l) => l.get(i).copied().unwrap_or(0),
                    None => g[..i].iter().filter(|x| x.contains('\n')).count(),
                }
            };
            let mut start = 0;
            for i in 1..=n {
                if i == n || line_of(i) != line_of(start) {
                    units.push((start, i));
                    start = i;
                }
            }
        }
    }
    let k = units.len();
    let step = |i: usize| 1.0 + c.jitter.clamp(0.0, 100.0) / 100.0 * (rnd(i, idx) * 2.0 - 1.0);
    let pause = |i: usize| {
        let s: String = g[units[i].0..units[i].1].concat();
        if i + 1 < k && is_punct(&s) {
            c.punct_pause.max(0.0) / 1000.0
        } else {
            0.0
        }
    };
    let mut t = Vec::with_capacity(k);
    let mut acc = 0.0;
    let per = match c.speed_mode {
        SpeedMode::Rate => 1.0 / rate.max(0.1),
        SpeedMode::Duration => 1.0,
    };
    for i in 0..k {
        acc += step(i) * per;
        t.push(acc);
        acc += pause(i);
    }
    if c.speed_mode == SpeedMode::Duration && k > 0 {
        // The last unit lands exactly on the duration (pauses scaled too).
        let last = t[k - 1].max(1e-9);
        let d = c.duration.max(0.0);
        for x in &mut t {
            *x *= d / last;
        }
    }
    let appear = if c.appear == Appear::Instant {
        0.0
    } else {
        c.appear_ms.max(0.0) / 1000.0
    };
    let mut unit_of = vec![0; n];
    for (i, (a, b)) in units.iter().enumerate() {
        for u in unit_of.iter_mut().take(*b).skip(*a) {
            *u = i;
        }
    }
    let type_end = t.last().copied().unwrap_or(0.0) + appear;
    let erase_dur = match c.erase {
        Erase::Block => 0.45,
        Erase::Backspace => n as f64 / c.erase_rate.max(1.0),
    };
    Timeline {
        g,
        units,
        t,
        unit_of,
        appear,
        type_end,
        erase_dur,
    }
}

/// The texts of the chain, fields filled in.
pub fn texts(layer: &Layer, data: &crate::anim::Data) -> Vec<String> {
    let LayerKind::Typewriter { text, x, .. } = &layer.kind else {
        return Vec::new();
    };
    std::iter::once(text.as_str())
        .chain(x.more.iter().map(|m| m.text.as_str()))
        .map(|t| interpolate_text(t, data))
        .collect()
}

pub fn has_next(c: &Config, n: usize, i: usize) -> bool {
    n > 1 && (c.chain_loop || i + 1 < n)
}

/// The text shown at elapsed `e` of a run started at `start`, and the
/// elapsed time within it. `tl(i)` gives the timeline of text `i`.
pub fn position(
    c: &Config,
    n: usize,
    start: usize,
    e: f64,
    tl: &mut dyn FnMut(usize) -> Timeline,
) -> (usize, f64) {
    if n == 0 {
        return (0, e);
    }
    let cycle = |t: &Timeline| t.type_end + c.hold.max(0.0) + t.erase_dur;
    let mut i = start.min(n - 1);
    let mut e = e.max(0.0);
    if c.chain_loop && n > 1 {
        let total: f64 = (0..n).map(|j| cycle(&tl(j))).sum();
        if total > 1e-6 {
            e %= total;
        }
    }
    for _ in 0..(4 * n + 4) {
        if !has_next(c, n, i) {
            return (i, e);
        }
        let cy = cycle(&tl(i));
        if e < cy {
            return (i, e);
        }
        e -= cy;
        i = (i + 1) % n;
    }
    (i, e)
}

/// The text shown and its elapsed time, "Show all" included.
pub fn now_at(
    c: &Config,
    st: &State,
    n: usize,
    e: f64,
    tl: &mut dyn FnMut(usize) -> Timeline,
) -> (usize, f64) {
    let mut e = e;
    if let Some(a) = st.all_at {
        if e >= a {
            let (i, ea) = position(c, n, st.idx, a, tl);
            e += (tl(i).type_end - ea).max(0.0);
        }
    }
    position(c, n, st.idx, e, tl)
}

/// Rate of the layer (its `speed`).
fn layer_parts(layer: &Layer) -> Option<(&Config, f64)> {
    match &layer.kind {
        LayerKind::Typewriter { x, speed, .. } => Some((x, *speed)),
        _ => None,
    }
}

/// Applies an operator action. Ops: `start`, `pause`, `resume`, `toggle`
/// (pause / resume), `showAll`, `next`, `clear`, `reset`, `edited`
/// (`{typed}`: the current text was changed while typing). Args may carry
/// `cur`: the text the Operator sees (exact with the line unit).
pub fn act(
    layer: &Layer,
    st: &mut State,
    op: &str,
    args: &serde_json::Value,
    ctx: &ActCtx,
) -> Result<(), String> {
    let (c, rate) = layer_parts(layer).ok_or("not a typewriter")?;
    let list = texts(layer, ctx.data);
    let n = list.len().max(1);
    let mut tl = |i: usize| timeline(c, rate, list.get(i).map_or("", |s| s.as_str()), i, None);
    let e = elapsed(st, ctx.now_ms, ctx.age_secs);
    let (mut cur, mut el) = if st.mode == Mode::Idle {
        (st.idx.min(n - 1), 0.0)
    } else {
        now_at(c, st, n, e, &mut tl)
    };
    if let Some(i) = args.get("cur").and_then(|v| v.as_u64()) {
        cur = (i as usize).min(n - 1);
    }
    let run_from = |st: &mut State, idx: usize, base: f64| {
        *st = State {
            mode: Mode::Run,
            idx,
            base,
            since: Some(ctx.now_ms),
            all_at: None,
        };
    };
    match op {
        "start" => run_from(st, cur, 0.0),
        "pause" | "resume" | "toggle" => {
            let running = matches!(st.mode, Mode::Auto | Mode::Run);
            if running && op != "resume" {
                // Keep the position: rebase on the text shown.
                *st = State {
                    mode: Mode::Paused,
                    idx: cur,
                    base: el,
                    since: None,
                    all_at: None,
                };
            } else if st.mode == Mode::Paused && op != "pause" {
                st.mode = Mode::Run;
                st.since = Some(ctx.now_ms);
            } else if st.mode == Mode::Idle && op != "pause" {
                run_from(st, cur, 0.0);
            }
        }
        "showAll" => {
            if st.mode == Mode::Auto {
                run_from(st, cur, el);
            } else if st.mode == Mode::Idle {
                *st = State {
                    mode: Mode::Paused,
                    idx: cur,
                    base: 0.0,
                    since: None,
                    all_at: None,
                };
            } else if st.idx != cur {
                // Rebase on the text shown so "all" applies to it.
                let since = st.since.map(|_| ctx.now_ms);
                *st = State {
                    mode: st.mode,
                    idx: cur,
                    base: el,
                    since,
                    all_at: None,
                };
            }
            let e2 = elapsed(st, ctx.now_ms, ctx.age_secs);
            st.all_at = Some(e2);
            if st.mode == Mode::Paused {
                // Paused: everything shown now.
                el = tl(cur).type_end;
                st.base = el;
                st.all_at = None;
            }
        }
        "next" => run_from(st, (cur + 1) % n, 0.0),
        "clear" => {
            *st = State {
                mode: Mode::Idle,
                idx: cur,
                ..Default::default()
            }
        }
        "reset" => {
            *st = State {
                mode: Mode::Idle,
                ..Default::default()
            }
        }
        "edited" => {
            let t = tl(cur);
            let paused = st.mode == Mode::Paused;
            let base = match c.on_edit {
                OnEdit::Restart => 0.0,
                OnEdit::Continue => {
                    let typed = args.get("typed").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    if typed == 0 {
                        0.0
                    } else if typed >= t.g.len() {
                        t.type_end
                    } else {
                        t.t[t.unit_of[typed - 1]]
                    }
                }
            };
            if st.mode == Mode::Idle {
                return Ok(());
            }
            run_from(st, cur, base);
            if paused {
                st.mode = Mode::Paused;
                st.since = None;
            }
        }
        _ => return Err(format!("unknown action `{op}`")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layer(extra: serde_json::Value) -> Layer {
        let mut v = json!({"id":"a","name":"T","type":"typewriter","text":"Hello world. Bye","speed":10.0,"props":{}});
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn old_typewriter_types_as_before() {
        let l = layer(json!({}));
        let LayerKind::Typewriter { x, speed, .. } = &l.kind else {
            panic!()
        };
        assert_eq!(*x, Config::default());
        let t = timeline(x, *speed, "Hello", 0, None);
        // As before: floor(age × speed) characters.
        assert!((t.t[0] - 0.1).abs() < 1e-9 && (t.t[4] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn units_and_duration() {
        let c = Config {
            unit: Unit::Word,
            speed_mode: SpeedMode::Duration,
            duration: 3.0,
            jitter: 40.0,
            punct_pause: 300.0,
            ..Default::default()
        };
        let t = timeline(&c, 10.0, "Hello world. Bye 👩‍💻", 0, None);
        assert_eq!(t.units.len(), 3);
        assert!((t.t[2] - 3.0).abs() < 1e-9);
        assert_eq!(t.g.len(), 18);
        // Deterministic.
        assert_eq!(t, timeline(&c, 10.0, "Hello world. Bye 👩‍💻", 0, None));
    }

    #[test]
    fn chaining_and_actions() {
        let l = layer(json!({"more":[{"text":"Two"}],"chainLoop":true,"hold":1.0}));
        let data = Default::default();
        let ctx = |now: i64| ActCtx {
            now_ms: now,
            age_secs: 0.0,
            data: &data,
        };
        let mut st = State::default();
        act(&l, &mut st, "start", &json!({}), &ctx(1000)).unwrap();
        assert_eq!(st.mode, Mode::Run);
        act(&l, &mut st, "pause", &json!({}), &ctx(1500)).unwrap();
        assert_eq!(st.mode, Mode::Paused);
        assert!((st.base - 0.5).abs() < 1e-9);
        act(&l, &mut st, "resume", &json!({}), &ctx(9000)).unwrap();
        assert!((elapsed(&st, 9500, 0.0) - 1.0).abs() < 1e-9);
        act(&l, &mut st, "next", &json!({}), &ctx(9500)).unwrap();
        assert_eq!(st.idx, 1);
        act(&l, &mut st, "showAll", &json!({}), &ctx(9600)).unwrap();
        let LayerKind::Typewriter { x, speed, .. } = &l.kind else {
            panic!()
        };
        let list = texts(&l, &data);
        let mut tl = |i: usize| timeline(x, *speed, &list[i], i, None);
        let (i, e) = now_at(x, &st, 2, elapsed(&st, 9600, 0.0), &mut tl);
        assert_eq!(i, 1);
        assert!(e >= tl(1).type_end - 1e-9);
        act(&l, &mut st, "clear", &json!({}), &ctx(9700)).unwrap();
        assert_eq!(st.mode, Mode::Idle);
        assert!(act(&l, &mut st, "nope", &json!({}), &ctx(0)).is_err());
    }
}
