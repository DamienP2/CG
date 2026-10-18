//! Table: data grid (manual grid with CSV paste, or a linked source: a
//! `{{key}}` whose data value is CSV / JSON rows), mapped columns, header row
//! and column, merges, widths fixed / auto / %, styles per level, borders,
//! conditional formatting, sort, pagination (pages or continuous scroll) and
//! a cascade of the rows. Operator: pages (next / prev / go / auto / pause)
//! and a highlighted row.
//! Drawn by `cg-render/src/wid/table.rs` and `web/src/widgets/table.tsx` (keep in sync).

use serde::{Deserialize, Serialize};

use super::ActCtx;
use crate::anim::{interpolate_text, Data};
use crate::model::{Layer, LayerKind};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColKind {
    #[default]
    Text,
    /// Picture: an asset path (`/assets/fr.png`), else a chip with the code.
    Image,
    Number,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

/// A mapped column: source column → label, type, alignment, width, format.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Col {
    pub src: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: ColKind,
    pub align: Align,
    /// Fixed width, px.
    pub w: f32,
    /// Share of the width, %.
    pub pct: f32,
    /// Number format: `0`, `0.0`, `+0`, `0 %`.
    pub fmt: String,
    pub on: bool,
}

impl Default for Col {
    fn default() -> Self {
        Self {
            src: String::new(),
            label: String::new(),
            kind: ColKind::Text,
            align: Align::Left,
            w: 100.0,
            pct: 10.0,
            fmt: "0".into(),
            on: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Merge {
    pub on: bool,
    /// Rank of the row (on the whole table, 1 = first).
    pub row: u32,
    /// First column (1 = left).
    pub col: u32,
    /// Number of cells.
    pub span: u32,
    pub text: String,
}

impl Default for Merge {
    fn default() -> Self {
        Self {
            on: true,
            row: 1,
            col: 1,
            span: 2,
            text: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Title {
    pub on: bool,
    pub text: String,
}

impl Default for Title {
    fn default() -> Self {
        Self {
            on: false,
            text: "Standings".into(),
        }
    }
}

/// Background and text colour of a level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Pair {
    pub bg: String,
    pub color: String,
}

impl Default for Pair {
    fn default() -> Self {
        Self::new("#141a33", "#ffffff")
    }
}

impl Pair {
    fn new(bg: &str, color: &str) -> Self {
        Self {
            bg: bg.into(),
            color: color.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Styles {
    pub header: Pair,
    /// Header column.
    pub hcol: Pair,
    pub odd: Pair,
    pub even: Pair,
    /// Highlighted row.
    pub hl: Pair,
    pub top3: Pair,
    pub table_bg: String,
}

impl Default for Styles {
    fn default() -> Self {
        Self {
            header: Pair::new("#7c5cff", "#ffffff"),
            hcol: Pair::new("#232a4d", "#ffffff"),
            odd: Pair::new("#141a33", "#ffffff"),
            even: Pair::new("#1c2344", "#ffffff"),
            hl: Pair::new("#ff3b5c", "#ffffff"),
            top3: Pair::new("#2c2717", "#fff4cc"),
            table_bg: "#060812d9".into(),
        }
    }
}

/// Style of one cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CellStyle {
    pub on: bool,
    pub row: u32,
    pub col: u32,
    pub bg: String,
    pub color: String,
}

impl Default for CellStyle {
    fn default() -> Self {
        Self {
            on: false,
            row: 1,
            col: 1,
            bg: "#facc15".into(),
            color: "#111111".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Line {
    pub on: bool,
    pub width: f32,
    pub color: String,
}

impl Default for Line {
    fn default() -> Self {
        Self {
            on: false,
            width: 1.0,
            color: "#ffffff1f".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Borders {
    pub outer: Line,
    pub inner_h: Line,
    pub inner_v: Line,
}

impl Default for Borders {
    fn default() -> Self {
        Self {
            outer: Line {
                on: false,
                width: 4.0,
                color: "#ffffff".into(),
            },
            inner_h: Line {
                on: true,
                width: 1.0,
                color: "#ffffff14".into(),
            },
            inner_v: Line::default(),
        }
    }
}

/// Conditional formatting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Cond {
    pub neg: bool,
    pub neg_color: String,
    pub top3: bool,
    pub top3_color: String,
}

impl Default for Cond {
    fn default() -> Self {
        Self {
            neg: true,
            neg_color: "#ff6b81".into(),
            top3: false,
            top3_color: "#facc15".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CascadeStyle {
    #[default]
    Slide,
    Fade,
    Flip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Cascade {
    pub on: bool,
    pub style: CascadeStyle,
    /// Between two rows, ms.
    pub offset: f64,
    /// Of one row, ms.
    pub dur: f64,
}

impl Default for Cascade {
    fn default() -> Self {
        Self {
            on: true,
            style: CascadeStyle::Slide,
            offset: 70.0,
            dur: 450.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WidthMode {
    #[default]
    Auto,
    Fixed,
    Percent,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Overflow {
    #[default]
    Shrink,
    Squeeze,
    Ellipsis,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDir {
    #[default]
    Desc,
    Asc,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageMode {
    #[default]
    Pages,
    Scroll,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmptyMode {
    #[default]
    Message,
    Hide,
}

/// Settings of the widget, flattened into the layer's JSON (every field
/// has a default so older projects still load). The text size of the cells
/// is the animated `fontSize` property.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Manual data, first row = column names (cells may hold `{{key}}`).
    pub grid: Vec<Vec<String>>,
    /// Linked source: `{{key}}` whose value is CSV or JSON rows (replaces the grid when set).
    pub link: String,
    /// Mapped columns (empty = every column of the data, as text).
    pub cols: Vec<Col>,
    pub title: Title,
    pub header_row: bool,
    pub header_col_on: bool,
    /// Source column styled as a header (and the key of the rows).
    pub header_col: String,
    /// A `#` column (display order).
    pub show_rank: bool,
    pub merges: Vec<Merge>,
    pub width_mode: WidthMode,
    pub row_h: f32,
    pub pad: f32,
    pub gap: f32,
    pub head_size: f32,
    pub overflow: Overflow,
    /// Shrink down to this size, px…
    pub min_size: f32,
    /// …then squeeze down to this width, %.
    pub min_squeeze: f32,
    pub st: Styles,
    pub cell: CellStyle,
    pub borders: Borders,
    pub cf: Cond,
    /// Source column to sort by ("" = data order).
    pub sort_col: String,
    pub sort_dir: SortDir,
    pub per_page: u32,
    pub repeat_header: bool,
    pub page_mode: PageMode,
    /// Continuous scroll, px/s.
    pub scroll_speed: f64,
    /// "2 / 4" under the table.
    pub indicator: bool,
    pub cascade: Cascade,
    pub empty_mode: EmptyMode,
    pub empty_text: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            grid: Vec::new(),
            link: String::new(),
            cols: Vec::new(),
            title: Title::default(),
            header_row: true,
            header_col_on: false,
            header_col: String::new(),
            show_rank: false,
            merges: Vec::new(),
            width_mode: WidthMode::Auto,
            row_h: 66.0,
            pad: 18.0,
            gap: 4.0,
            head_size: 20.0,
            overflow: Overflow::Shrink,
            min_size: 20.0,
            min_squeeze: 70.0,
            st: Styles::default(),
            cell: CellStyle::default(),
            borders: Borders::default(),
            cf: Cond::default(),
            sort_col: String::new(),
            sort_dir: SortDir::Desc,
            per_page: 7,
            repeat_header: true,
            page_mode: PageMode::Pages,
            scroll_speed: 50.0,
            indicator: true,
            cascade: Cascade::default(),
            empty_mode: EmptyMode::Message,
            empty_text: "No data yet".into(),
        }
    }
}

// ------------------------------------------------------------------ data --

/// Rows of a CSV text (`,` `;` or tab, the first one found in the first
/// line; quotes allowed), like the kit's `parseCsv`.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.trim().is_empty())
        .collect();
    let first = lines.first().copied().unwrap_or("");
    let sep = [';', '\t', ',']
        .into_iter()
        .find(|s| first.contains(*s))
        .unwrap_or(',');
    lines
        .iter()
        .map(|l| {
            let mut out = Vec::new();
            let mut cur = String::new();
            let mut q = false;
            let cs: Vec<char> = l.chars().collect();
            let mut i = 0;
            while i < cs.len() {
                let ch = cs[i];
                if q {
                    if ch == '"' && cs.get(i + 1) == Some(&'"') {
                        cur.push('"');
                        i += 1;
                    } else if ch == '"' {
                        q = false;
                    } else {
                        cur.push(ch);
                    }
                } else if ch == '"' {
                    q = true;
                } else if ch == sep {
                    out.push(std::mem::take(&mut cur));
                } else {
                    cur.push(ch);
                }
                i += 1;
            }
            out.push(cur);
            out.into_iter().map(|s| s.trim().to_string()).collect()
        })
        .collect()
}

fn json_cell(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Rows of a linked value: a JSON array (of arrays, or of objects: the keys
/// make the header) or CSV text.
pub fn parse_rows(text: &str) -> Vec<Vec<String>> {
    let t = text.trim();
    if t.starts_with('[') || t.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
            let arr = match &v {
                serde_json::Value::Array(a) => a.clone(),
                serde_json::Value::Object(o) => o
                    .get("rows")
                    .or_else(|| o.get("data"))
                    .and_then(|x| x.as_array().cloned())
                    .unwrap_or_default(),
                _ => Vec::new(),
            };
            if arr.iter().all(|r| r.is_array()) {
                return arr
                    .iter()
                    .map(|r| r.as_array().unwrap().iter().map(json_cell).collect())
                    .collect();
            }
            let mut head: Vec<String> = Vec::new();
            for r in &arr {
                if let Some(o) = r.as_object() {
                    for k in o.keys() {
                        if !head.contains(k) {
                            head.push(k.clone());
                        }
                    }
                }
            }
            let mut out = vec![head.clone()];
            for r in &arr {
                if let Some(o) = r.as_object() {
                    out.push(
                        head.iter()
                            .map(|k| o.get(k).map(json_cell).unwrap_or_default())
                            .collect(),
                    );
                }
            }
            return out;
        }
    }
    parse_csv(text)
}

/// The data grid: the linked source when set, else the manual grid (cells interpolated).
pub fn grid(c: &Config, data: &Data) -> Vec<Vec<String>> {
    if !c.link.trim().is_empty() {
        return parse_rows(&interpolate_text(&c.link, data));
    }
    c.grid
        .iter()
        .map(|r| r.iter().map(|s| interpolate_text(s, data)).collect())
        .collect()
}

/// A number of a cell ("1 234,5", "−3" allowed).
pub fn num(s: &str) -> Option<f64> {
    let t: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{a0}' && *c != '\u{202f}')
        .map(|c| match c {
            '−' => '-',
            ',' => '.',
            c => c,
        })
        .collect();
    let t = t.trim_end_matches('%');
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// A number written with a format (`0`, `0.0`, `+0`, `0 %`); text stays as is.
pub fn fmt_num(s: &str, f: &str) -> String {
    let Some(n) = num(s) else {
        return s.to_string();
    };
    let minus = if n < 0.0 { "−" } else { "" };
    match f {
        "0.0" => format!("{minus}{:.1}", n.abs()),
        "+0" => {
            let r = n.round();
            if r > 0.0 {
                format!("+{}", r.abs())
            } else {
                format!("{}{}", if r < 0.0 { "−" } else { "" }, r.abs())
            }
        }
        "0 %" => format!("{minus}{} %", n.abs().round()),
        _ => {
            let r = n.abs().round() as u64;
            let mut digits = r.to_string();
            if r >= 1000 {
                let b = digits.as_bytes();
                let mut o = String::new();
                for (i, ch) in b.iter().enumerate() {
                    if i > 0 && (b.len() - i) % 3 == 0 {
                        o.push(' ');
                    }
                    o.push(*ch as char);
                }
                digits = o;
            }
            format!("{minus}{digits}")
        }
    }
}

/// A shown column: a mapped one (with its index in the data) or the rank.
#[derive(Debug, Clone, PartialEq)]
pub struct MCol {
    pub col: Col,
    /// Index in the data row (None = the rank column).
    pub i: Option<usize>,
}

impl MCol {
    pub fn rank(&self) -> bool {
        self.i.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MRow {
    pub r: Vec<String>,
    /// Order in the data.
    pub k: usize,
    /// Key of the row (header column, or the first text column).
    pub key: String,
    /// Display order, 1 = first.
    pub rank: usize,
}

/// The table: the shown columns, the sorted rows, and what is not mapped / missing.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Model {
    pub head: Vec<String>,
    pub cols: Vec<MCol>,
    pub rows: Vec<MRow>,
    /// Columns of the data not mapped (ignored until mapped).
    pub unmapped: Vec<String>,
    /// Mapped columns not in the data.
    pub missing: Vec<String>,
}

pub fn rank_col() -> Col {
    Col {
        src: String::new(),
        label: "#".into(),
        kind: ColKind::Number,
        align: Align::Center,
        w: 80.0,
        pct: 7.0,
        fmt: "0".into(),
        on: true,
    }
}

pub fn model(c: &Config, data: &Data) -> Model {
    let g = grid(c, data);
    let head: Vec<String> = g
        .first()
        .map(|r| r.iter().map(|h| h.trim().to_string()).collect())
        .unwrap_or_default();
    let body: Vec<Vec<String>> = g
        .iter()
        .skip(1)
        .filter(|r| r.iter().any(|x| !x.trim().is_empty()))
        .cloned()
        .collect();
    let mut cols = Vec::new();
    let mut missing = Vec::new();
    let auto = c.cols.is_empty();
    let mapped: Vec<Col> = if auto {
        head.iter()
            .filter(|h| !h.is_empty())
            .map(|h| Col {
                src: h.clone(),
                label: h.clone(),
                ..Col::default()
            })
            .collect()
    } else {
        c.cols.clone()
    };
    for col in mapped.iter().filter(|x| x.on) {
        match head.iter().position(|h| *h == col.src) {
            Some(i) => cols.push(MCol {
                col: col.clone(),
                i: Some(i),
            }),
            None => missing.push(col.src.clone()),
        }
    }
    if c.show_rank {
        cols.insert(
            0,
            MCol {
                col: rank_col(),
                i: None,
            },
        );
    }
    let unmapped = if auto {
        Vec::new()
    } else {
        head.iter()
            .filter(|h| !h.is_empty() && !c.cols.iter().any(|x| x.src == **h))
            .cloned()
            .collect()
    };
    let key_i = cols
        .iter()
        .find(|m| !m.rank() && c.header_col_on && m.col.src == c.header_col)
        .or_else(|| {
            cols.iter()
                .find(|m| m.col.kind == ColKind::Text && !m.rank())
        })
        .and_then(|m| m.i);
    let mut rows: Vec<MRow> = body
        .into_iter()
        .enumerate()
        .map(|(k, r)| MRow {
            key: key_i
                .map(|i| r.get(i).cloned().unwrap_or_default())
                .unwrap_or_else(|| (k + 1).to_string()),
            r,
            k,
            rank: 0,
        })
        .collect();
    if let Some(si) = cols
        .iter()
        .find(|m| !m.rank() && !c.sort_col.is_empty() && m.col.src == c.sort_col)
        .and_then(|m| m.i)
    {
        let dir = if c.sort_dir == SortDir::Asc {
            1.0
        } else {
            -1.0
        };
        rows.sort_by(|a, b| {
            let x = a.r.get(si).map(String::as_str).unwrap_or("");
            let y = b.r.get(si).map(String::as_str).unwrap_or("");
            let d = match (num(x), num(y)) {
                (Some(nx), Some(ny)) => nx.partial_cmp(&ny).unwrap_or(std::cmp::Ordering::Equal),
                _ => x.to_lowercase().cmp(&y.to_lowercase()),
            };
            let d = if dir < 0.0 { d.reverse() } else { d };
            d.then(a.k.cmp(&b.k))
        });
    }
    for (i, r) in rows.iter_mut().enumerate() {
        r.rank = i + 1;
    }
    Model {
        head,
        cols,
        rows,
        unmapped,
        missing,
    }
}

pub fn page_count(c: &Config, m: &Model) -> usize {
    let per = c.per_page.max(1) as usize;
    m.rows.len().div_ceil(per).max(1)
}

/// The text of a cell.
pub fn cell_text(col: &MCol, row: &MRow) -> String {
    match col.i {
        None => row.rank.to_string(),
        Some(i) => {
            let v = row.r.get(i).cloned().unwrap_or_default();
            if col.col.kind == ColKind::Number {
                fmt_num(&v, &col.col.fmt)
            } else {
                v
            }
        }
    }
}

/// The merge of a row, if any: (first column index, span, text).
pub fn merge_of<'a>(c: &'a Config, m: &Model, row: &MRow) -> Option<(usize, usize, &'a str)> {
    let g = c
        .merges
        .iter()
        .find(|g| g.on && g.row as usize == row.rank)?;
    let j = (g.col.max(1) - 1) as usize;
    if j >= m.cols.len() {
        return None;
    }
    let span = (g.span.max(1) as usize).min(m.cols.len() - j);
    Some((j, span, g.text.as_str()))
}

/// Heights: title bar, header row.
pub const TITLE_H: f32 = 64.0;
pub fn header_h(c: &Config) -> f32 {
    (c.row_h * 0.85).round()
}

// ----------------------------------------------------------------- state --

/// What the operator changes on air: the page, auto pages, the highlighted row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    /// Page shown when auto pages started (or the page set), 0 = first.
    pub page: usize,
    /// When the page last changed (cascade), Unix ms; 0 = on air.
    pub page_at: i64,
    /// Auto pages: on, every `interval` s, counted from `auto_at`.
    pub auto: bool,
    pub interval: f64,
    pub auto_at: i64,
    /// Paused at (Unix ms), 0 = running.
    pub paused_at: i64,
    /// Key of the highlighted row ("" = none).
    pub hl: String,
}

/// Page shown at `now` and when it appeared (Unix ms, 0 = since on air).
pub fn current_page(st: &State, pages: usize, now_ms: i64) -> (usize, i64) {
    let pages = pages.max(1);
    if st.auto && st.interval > 0.0 && st.auto_at > 0 && pages > 1 {
        let t = if st.paused_at > 0 {
            st.paused_at
        } else {
            now_ms
        };
        let step = (st.interval * 1000.0) as i64;
        let n = ((t - st.auto_at).max(0) / step.max(1)) as usize;
        let at = if n > 0 {
            st.auto_at + n as i64 * step
        } else {
            st.page_at
        };
        return ((st.page + n) % pages, at);
    }
    (st.page.min(pages - 1), st.page_at)
}

/// Seconds left before the next automatic page (None = not running).
pub fn next_in(st: &State, now_ms: i64) -> Option<f64> {
    if !st.auto || st.interval <= 0.0 || st.auto_at <= 0 {
        return None;
    }
    let t = if st.paused_at > 0 {
        st.paused_at
    } else {
        now_ms
    };
    let step = st.interval * 1000.0;
    let e = (t - st.auto_at).max(0) as f64 % step;
    Some((step - e) / 1000.0)
}

fn config(layer: &Layer) -> Result<&Config, String> {
    match &layer.kind {
        LayerKind::Table { x } => Ok(x),
        _ => Err("not a table".into()),
    }
}

fn go(st: &mut State, pages: usize, p: i64, now: i64) {
    let pages = pages.max(1) as i64;
    st.page = p.rem_euclid(pages) as usize;
    st.page_at = now;
    if st.auto {
        st.auto_at = now;
        if st.paused_at > 0 {
            st.paused_at = now;
        }
    }
}

/// Applies an operator action (`op`, with its `args`) to the state.
/// next · prev · go {page: 1…} · auto {seconds} · pause · resume · stop ·
/// highlight {row: key or rank, "" = none}.
pub fn act(
    layer: &Layer,
    st: &mut State,
    op: &str,
    args: &serde_json::Value,
    ctx: &ActCtx,
) -> Result<(), String> {
    let c = config(layer)?;
    let m = model(c, ctx.data);
    let pages = page_count(c, &m);
    let now = ctx.now_ms;
    let (cur, _) = current_page(st, pages, now);
    let scroll = c.page_mode == PageMode::Scroll;
    match op {
        "next" | "prev" | "go" if scroll => {
            return Err("continuous scroll: no pages".into());
        }
        "next" => go(st, pages, cur as i64 + 1, now),
        "prev" => go(st, pages, cur as i64 - 1, now),
        "go" => {
            let p = args
                .get("page")
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.trim().parse().ok()))
                .ok_or("page number needed")?;
            if p < 1 || p as usize > pages {
                return Err(format!("page {p} does not exist (1 to {pages})"));
            }
            go(st, pages, p - 1, now);
        }
        "auto" => {
            let secs = args
                .get("seconds")
                .and_then(|v| v.as_f64())
                .unwrap_or(if st.interval > 0.0 { st.interval } else { 6.0 });
            if secs <= 0.0 {
                st.page = cur;
                st.auto = false;
                st.paused_at = 0;
                return Ok(());
            }
            if !(0.5..=3600.0).contains(&secs) {
                return Err("interval: 0.5 to 3600 s".into());
            }
            if st.auto && st.auto_at > 0 {
                // New interval: keep the page, count from now.
                st.page = cur;
                st.auto_at = if st.paused_at > 0 { st.paused_at } else { now };
            } else {
                st.page = cur;
                st.auto_at = now;
                st.paused_at = 0;
            }
            st.auto = true;
            st.interval = secs;
        }
        "stop" => {
            st.page = cur;
            st.auto = false;
            st.paused_at = 0;
        }
        "pause" => {
            if st.auto && st.paused_at == 0 {
                st.paused_at = now;
            }
        }
        "resume" => {
            if st.auto && st.paused_at > 0 {
                st.auto_at += now - st.paused_at;
                st.paused_at = 0;
            }
        }
        "highlight" => {
            let v = args.get("row").cloned().unwrap_or(serde_json::Value::Null);
            let key = match &v {
                serde_json::Value::Number(n) => {
                    let rank = n.as_u64().unwrap_or(0) as usize;
                    m.rows
                        .iter()
                        .find(|r| r.rank == rank)
                        .map(|r| r.key.clone())
                        .ok_or(format!("no row {rank}"))?
                }
                serde_json::Value::String(s) => s.trim().to_string(),
                _ => String::new(),
            };
            if key.is_empty() {
                st.hl.clear();
                return Ok(());
            }
            let row = m
                .rows
                .iter()
                .find(|r| r.key == key)
                .ok_or(format!("no row `{key}`"))?;
            st.hl = key;
            if !scroll {
                let p = (row.rank - 1) / c.per_page.max(1) as usize;
                if p != cur {
                    go(st, pages, p as i64, now);
                } else {
                    st.page = cur;
                    if st.auto {
                        st.auto_at = now;
                    }
                }
            }
        }
        _ => return Err(format!("unknown action `{op}`")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(c: Config) -> Layer {
        let mut l: Layer =
            serde_json::from_str(r#"{"id":"t","name":"T","type":"table","props":{}}"#).unwrap();
        l.kind = LayerKind::Table { x: c };
        l
    }
    fn sample(n: usize) -> Config {
        let mut grid = vec![vec!["Team".to_string(), "Pts".to_string()]];
        for i in 0..n {
            grid.push(vec![format!("T{i}"), format!("{}", i * 3)]);
        }
        Config {
            grid,
            per_page: 4,
            cols: vec![
                Col {
                    src: "Team".into(),
                    label: "Team".into(),
                    ..Col::default()
                },
                Col {
                    src: "Pts".into(),
                    label: "Pts".into(),
                    kind: ColKind::Number,
                    ..Col::default()
                },
            ],
            sort_col: "Pts".into(),
            ..Config::default()
        }
    }
    fn ctx(data: &Data, now: i64) -> ActCtx<'_> {
        ActCtx {
            now_ms: now,
            age_secs: 0.0,
            data,
        }
    }

    #[test]
    fn old_tables_load() {
        let l: Layer =
            serde_json::from_str(r#"{"id":"a","name":"T","type":"table","props":{}}"#).unwrap();
        let LayerKind::Table { x } = l.kind else {
            panic!()
        };
        assert_eq!(x, Config::default());
    }

    #[test]
    fn sorted_and_paged() {
        let c = sample(10);
        let m = model(&c, &Data::new());
        assert_eq!(m.rows[0].key, "T9");
        assert_eq!(page_count(&c, &m), 3);
        assert_eq!(fmt_num("-3", "+0"), "−3");
        assert_eq!(fmt_num("5", "+0"), "+5");
        assert_eq!(fmt_num("12345", "0"), "12 345");
    }

    #[test]
    fn pages_and_auto() {
        let l = layer(sample(10));
        let d = Data::new();
        let mut st = State::default();
        act(
            &l,
            &mut st,
            "next",
            &serde_json::Value::Null,
            &ctx(&d, 1000),
        )
        .unwrap();
        assert_eq!(st.page, 1);
        act(
            &l,
            &mut st,
            "prev",
            &serde_json::Value::Null,
            &ctx(&d, 1000),
        )
        .unwrap();
        act(
            &l,
            &mut st,
            "prev",
            &serde_json::Value::Null,
            &ctx(&d, 1000),
        )
        .unwrap();
        assert_eq!(st.page, 2);
        assert!(act(
            &l,
            &mut st,
            "go",
            &serde_json::json!({"page": 9}),
            &ctx(&d, 1)
        )
        .is_err());
        act(
            &l,
            &mut st,
            "auto",
            &serde_json::json!({"seconds": 5}),
            &ctx(&d, 10_000),
        )
        .unwrap();
        assert_eq!(current_page(&st, 3, 16_000).0, 0);
        act(
            &l,
            &mut st,
            "pause",
            &serde_json::Value::Null,
            &ctx(&d, 16_000),
        )
        .unwrap();
        assert_eq!(current_page(&st, 3, 60_000).0, 0);
        act(
            &l,
            &mut st,
            "resume",
            &serde_json::Value::Null,
            &ctx(&d, 60_000),
        )
        .unwrap();
        assert_eq!(current_page(&st, 3, 64_100).0, 1);
    }

    #[test]
    fn data_update_keeps_the_page() {
        let st = State {
            page: 2,
            ..State::default()
        };
        assert_eq!(current_page(&st, 3, 0).0, 2);
        // The data shrinks to two pages: the last one.
        assert_eq!(current_page(&st, 2, 0).0, 1);
    }

    #[test]
    fn highlight_goes_to_its_page() {
        let l = layer(sample(10));
        let d = Data::new();
        let mut st = State::default();
        act(
            &l,
            &mut st,
            "highlight",
            &serde_json::json!({"row": "T0"}),
            &ctx(&d, 5),
        )
        .unwrap();
        assert_eq!(st.page, 2);
        act(
            &l,
            &mut st,
            "highlight",
            &serde_json::json!({"row": 1}),
            &ctx(&d, 5),
        )
        .unwrap();
        assert_eq!((st.hl.as_str(), st.page), ("T9", 0));
    }

    #[test]
    fn linked_source_and_unmapped_columns() {
        let mut c = sample(0);
        c.link = "{{rows}}".into();
        let mut d = Data::new();
        d.insert(
            "rows".into(),
            r#"[{"Team":"A","Pts":"3","xG":"1.2"},{"Team":"B","Pts":"7","xG":"0.4"}]"#.into(),
        );
        let m = model(&c, &d);
        assert_eq!(m.rows.len(), 2);
        assert_eq!(m.unmapped, vec!["xG".to_string()]);
        d.insert("rows".into(), "Team;Pts\nC;1\nD;2\nE;3".into());
        assert_eq!(model(&c, &d).rows.len(), 3);
    }
}
