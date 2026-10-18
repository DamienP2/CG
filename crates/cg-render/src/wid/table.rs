//! Table: drawing (same picture as `web/src/widgets/table.tsx`).

use ab_glyph::FontArc;
use cg_core::wid::table::{
    cell_text, current_page, header_h, merge_of, model, page_count, Align, CascadeStyle, ColKind,
    Config, EmptyMode, MRow, Model, Overflow, PageMode, State, TITLE_H,
};
use cg_core::{Color, LayerKind, Prop, TextAlign, VerticalAlign};
use tiny_skia::{
    FillRule, GradientStop, LinearGradient, Mask, Paint, Point, SpreadMode, Transform,
};

use super::{rrect, Draw};
use crate::text as tx;

pub(crate) const FAMILY: &str = "Inter";

/// Fills a rectangle (or a rounded one).
pub(crate) fn rect(
    d: &mut Draw,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    r: f32,
    c: Color,
    m: Option<&Mask>,
) {
    if w <= 0.0 || h <= 0.0 || c.0[3] <= 0.0 {
        return;
    }
    if let Some(p) = rrect(x, y, w, h, r) {
        d.fill(&p, c, FillRule::Winding, m);
    }
}

pub(crate) fn with_alpha(c: Color, a: f32) -> Color {
    Color([c.0[0], c.0[1], c.0[2], c.0[3] * a])
}

/// How a too-long text fits its box: shrink → squeeze → ellipsis.
#[derive(Clone, Copy)]
pub(crate) struct Fit {
    pub overflow: Overflow,
    pub min_size: f32,
    pub min_squeeze: f32,
}

/// Lays out one line of text in (x, y, w, h), fitted; returns the path and whether it was fitted.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fitted_path(
    font: &FontArc,
    s: &str,
    size: f32,
    ls: f32,
    align: TextAlign,
    (x, y, w, h): (f32, f32, f32, f32),
    fit: Option<Fit>,
) -> (Option<tiny_skia::Path>, bool) {
    let mut style = tx::TextStyle {
        size,
        letter_spacing: ls,
        align,
        vertical_align: VerticalAlign::Middle,
        box_w: w.max(1.0),
        box_h: h.max(size),
        line_height: tx::LINE_HEIGHT,
        decoration: cg_core::TextDecoration::None,
    };
    let (mut text, mut sx, mut changed) = (s.to_string(), 1.0f32, false);
    if let Some(f) = fit {
        use cg_core::TextOverflow as O;
        let r = match f.overflow {
            Overflow::Ellipsis => tx::fit_text(font, s, &style, false, O::Ellipsis, 1.0, 1.0),
            Overflow::Squeeze => {
                tx::fit_text(font, s, &style, false, O::Fit, f.min_squeeze / 100.0, 1.0)
            }
            Overflow::Shrink => tx::fit_text(
                font,
                s,
                &style,
                false,
                O::Fit,
                f.min_squeeze / 100.0,
                (f.min_size / size).min(1.0),
            ),
        };
        changed = r.size != size || r.squeeze != 1.0 || r.text != s;
        style.size = r.size;
        sx = r.squeeze;
        text = r.text;
        if r.clip && f.overflow != Overflow::Ellipsis {
            // At the minimum: cut with an ellipsis.
            let mut st2 = tx::TextStyle {
                box_w: w / sx,
                ..style
            };
            st2.size = r.size;
            text = tx::fit_text(font, &text, &st2, false, O::Ellipsis, 1.0, 1.0).text;
        }
    }
    style.box_w = (w / sx).max(1.0);
    let p = tx::layout_text(font, &text, &style)
        .and_then(|p| p.transform(Transform::from_row(sx, 0.0, 0.0, 1.0, x, y)));
    (p, changed)
}

pub(crate) fn align_of(a: Align) -> TextAlign {
    match a {
        Align::Left => TextAlign::Left,
        Align::Center => TextAlign::Center,
        Align::Right => TextAlign::Right,
    }
}

/// Column widths for the mode (fixed px, auto from the content, % of the width).
pub(crate) fn widths(d: &mut Draw, c: &Config, m: &Model, size: f32) -> Vec<f32> {
    let n = m.cols.len();
    let avail = d.w - c.gap * (n.max(1) - 1) as f32;
    match c.width_mode {
        cg_core::wid::table::WidthMode::Fixed => m.cols.iter().map(|x| x.col.w).collect(),
        cg_core::wid::table::WidthMode::Percent => {
            let rk = if m.cols.iter().any(|x| x.rank()) {
                80.0
            } else {
                0.0
            };
            m.cols
                .iter()
                .map(|x| {
                    if x.rank() {
                        80.0
                    } else {
                        x.col.pct / 100.0 * (avail - rk)
                    }
                })
                .collect()
        }
        cg_core::wid::table::WidthMode::Auto => {
            let f7 = d.font(FAMILY, 700);
            let f8 = d.font(FAMILY, 800);
            let (Some(f7), Some(f8)) = (f7, f8) else {
                return vec![avail / n.max(1) as f32; n];
            };
            let nat: Vec<f32> = m
                .cols
                .iter()
                .map(|x| {
                    if x.col.kind == ColKind::Image {
                        return c.row_h * 0.75 + 2.0 * c.pad;
                    }
                    let mut w = tx::text_width(&f8, &x.col.label.to_uppercase(), c.head_size, 0.0);
                    for r in &m.rows {
                        let f = if x.col.kind == ColKind::Number {
                            &f8
                        } else {
                            &f7
                        };
                        w = w.max(tx::text_width(f, &cell_text(x, r), size, 0.0));
                    }
                    w.min(600.0) + 2.0 * c.pad + 8.0
                })
                .collect();
            let is_text: Vec<bool> = m
                .cols
                .iter()
                .map(|x| x.col.kind == ColKind::Text && !x.rank())
                .collect();
            let fixed: f32 = nat
                .iter()
                .zip(&is_text)
                .filter(|(_, t)| !**t)
                .map(|(w, _)| w)
                .sum();
            let text_nat: f32 = nat
                .iter()
                .zip(&is_text)
                .filter(|(_, t)| **t)
                .map(|(w, _)| w)
                .sum();
            let rest = avail - fixed;
            if text_nat <= 0.0 || rest < text_nat * 0.25 {
                let sum: f32 = nat.iter().sum::<f32>().max(1.0);
                return nat.iter().map(|w| w * avail / sum).collect();
            }
            nat.iter()
                .zip(&is_text)
                .map(|(w, t)| if *t { w * rest / text_nat } else { *w })
                .collect()
        }
    }
}

fn ease_out(k: f32) -> f32 {
    1.0 - (1.0 - k.clamp(0.0, 1.0)).powi(3)
}

struct RowLook {
    bg: Color,
    color: Color,
    hl: bool,
    top3: bool,
}

fn row_look(c: &Config, st: &State, row: &MRow) -> RowLook {
    let h = |s: &str| Draw::hex(s);
    if !row.key.is_empty() && row.key == st.hl {
        return RowLook {
            bg: h(&c.st.hl.bg),
            color: h(&c.st.hl.color),
            hl: true,
            top3: false,
        };
    }
    if c.cf.top3 && row.rank <= 3 {
        return RowLook {
            bg: h(&c.st.top3.bg),
            color: h(&c.st.top3.color),
            hl: false,
            top3: true,
        };
    }
    let p = if row.rank % 2 == 1 {
        &c.st.odd
    } else {
        &c.st.even
    };
    RowLook {
        bg: h(&p.bg),
        color: h(&p.color),
        hl: false,
        top3: false,
    }
}

/// Draws the layer; false = not handled here (the generic code draws it).
pub(crate) fn draw(d: &mut Draw, st: &State) -> bool {
    let LayerKind::Table { x: c } = &d.layer.kind else {
        return false;
    };
    let c = c.clone();
    let m = model(&c, d.data);
    let size = d.num(Prop::FontSize).max(1.0);
    if m.rows.is_empty() && c.empty_mode == EmptyMode::Hide {
        return true;
    }
    let pages = page_count(&c, &m);
    let (page, at) = current_page(st, pages, d.time.now_ms);
    let since = if at > 0 {
        (d.time.now_ms - at) as f64 / 1000.0
    } else {
        d.time.age_secs
    } as f32;
    let scroll = c.page_mode == PageMode::Scroll;
    let ws = widths(d, &c, &m, size);
    let mut xs = Vec::with_capacity(ws.len());
    let mut acc = 0.0;
    for w in &ws {
        xs.push(acc);
        acc += w + c.gap;
    }
    let (rh, gap, pad) = (c.row_h, c.gap, c.pad);
    let hh = header_h(&c);
    let show_head = c.header_row && (scroll || c.repeat_header || page == 0);
    let title_h = if c.title.on { TITLE_H } else { 0.0 };
    let boxed = d.boxed();
    let bm = boxed.as_ref();
    let fit = Fit {
        overflow: c.overflow,
        min_size: c.min_size,
        min_squeeze: c.min_squeeze,
    };
    let per = c.per_page.max(1) as usize;
    let list: Vec<&MRow> = if scroll {
        m.rows.iter().collect()
    } else {
        m.rows.iter().skip(page * per).take(per).collect()
    };
    let shown_n = if scroll { per } else { list.len() };
    let clip_h = if m.rows.is_empty() {
        rh * 2.0
    } else {
        (per.min(shown_n) as f32 * (rh + gap) - gap).max(0.0)
    };
    let mut y = 0.0;
    if c.title.on {
        y += title_h + gap;
    }
    if show_head {
        y += hh + gap;
    }
    let total_h = y + clip_h;
    // Background of the table.
    rect(
        d,
        0.0,
        0.0,
        d.w,
        total_h,
        0.0,
        Draw::hex(&c.st.table_bg),
        bm,
    );
    let h_line = c.borders.inner_h.clone();
    let v_line = c.borders.inner_v.clone();
    let lines =
        |d: &mut Draw, x: f32, y: f32, w: f32, h: f32, top: bool, left: bool, m: Option<&Mask>| {
            if top && h_line.on {
                rect(
                    d,
                    x,
                    y,
                    w,
                    h_line.width.min(h),
                    0.0,
                    Draw::hex(&h_line.color),
                    m,
                );
            }
            if left && v_line.on {
                rect(
                    d,
                    x,
                    y,
                    v_line.width.min(w),
                    h,
                    0.0,
                    Draw::hex(&v_line.color),
                    m,
                );
            }
        };
    let mut yy = 0.0;
    if c.title.on {
        if let Some(p) = rrect(0.0, 0.0, d.w, title_h, 0.0) {
            let grad = LinearGradient::new(
                Point::from_xy(0.0, 0.0),
                Point::from_xy(d.w, 0.0),
                vec![
                    GradientStop::new(0.0, tiny_skia::Color::from_rgba8(0xff, 0x3b, 0x5c, 255)),
                    GradientStop::new(1.0, tiny_skia::Color::from_rgba8(0x7c, 0x5c, 0xff, 255)),
                ],
                SpreadMode::Pad,
                Transform::identity(),
            );
            if let Some(sh) = grad {
                let paint = Paint {
                    shader: sh,
                    anti_alias: true,
                    ..Paint::default()
                };
                let mut paint = paint;
                paint.shader.apply_opacity(d.opacity);
                d.fill_paint(&p, &paint, FillRule::Winding, bm);
            }
        }
        if let Some(f) = d.font(FAMILY, 900) {
            let (p, _) = fitted_path(
                &f,
                &c.title.text.to_uppercase(),
                30.0,
                30.0 * 0.04,
                TextAlign::Left,
                (24.0, 0.0, d.w - 48.0, title_h),
                Some(Fit {
                    overflow: Overflow::Shrink,
                    min_size: 18.0,
                    min_squeeze: 70.0,
                }),
            );
            if let Some(p) = p {
                d.fill(&p, Color::WHITE, FillRule::Winding, bm);
            }
        }
        yy += title_h + gap;
    }
    if show_head {
        let hf = d.font(FAMILY, 800);
        for (j, mc) in m.cols.iter().enumerate() {
            rect(d, xs[j], yy, ws[j], hh, 0.0, Draw::hex(&c.st.header.bg), bm);
            lines(d, xs[j], yy, ws[j], hh, false, j > 0, bm);
            if let Some(f) = &hf {
                let (p, _) = fitted_path(
                    f,
                    &mc.col.label.to_uppercase(),
                    c.head_size,
                    c.head_size * 0.05,
                    align_of(mc.col.align),
                    (xs[j] + pad, yy, ws[j] - 2.0 * pad, hh),
                    Some(fit),
                );
                if let Some(p) = p {
                    d.fill(&p, Draw::hex(&c.st.header.color), FillRule::Winding, bm);
                }
            }
        }
        yy += hh + gap;
    }
    let y0 = yy;
    if m.rows.is_empty() {
        let o = 0.85;
        let bg = with_alpha(Draw::hex(&c.st.odd.bg), o);
        rect(d, 0.0, y0, d.w, rh * 2.0, 0.0, bg, bm);
        if let Some(f) = d.font(FAMILY, 700) {
            let (p, _) = fitted_path(
                &f,
                &c.empty_text,
                size,
                0.0,
                TextAlign::Center,
                (pad, y0, d.w - 2.0 * pad, rh * 2.0),
                Some(fit),
            );
            if let Some(p) = p {
                d.fill(
                    &p,
                    with_alpha(Draw::hex(&c.st.odd.color), o),
                    FillRule::Winding,
                    bm,
                );
            }
        }
    } else {
        let region = d.clip(0.0, y0, d.w, clip_h);
        let rm = region.as_ref().or(bm);
        let step = rh + gap;
        let looped = scroll && m.rows.len() > per;
        let off = if looped {
            (c.scroll_speed as f32 * d.time.age_secs as f32).rem_euclid(m.rows.len() as f32 * step)
        } else {
            0.0
        };
        let shown: Vec<&MRow> = if looped {
            list.iter().chain(list.iter()).copied().collect()
        } else {
            list.clone()
        };
        let f7 = d.font(FAMILY, 700);
        let f8 = d.font(FAMILY, 800);
        let (tf0, op0) = (d.tf, d.opacity);
        for (i, row) in shown.iter().enumerate() {
            let ry = y0 + i as f32 * step - off;
            if ry > y0 + clip_h || ry + rh < y0 {
                continue;
            }
            // Cascade of the rows (pages).
            if !scroll && c.cascade.on {
                let t = (since * 1000.0 - i as f32 * c.cascade.offset as f32)
                    / (c.cascade.dur as f32).max(1.0);
                let k = ease_out(t);
                match c.cascade.style {
                    CascadeStyle::Slide => {
                        d.tf = tf0.pre_translate((1.0 - k) * -80.0, 0.0);
                        d.opacity = op0 * k;
                    }
                    CascadeStyle::Fade => d.opacity = op0 * k,
                    CascadeStyle::Flip => {
                        let a = ((1.0 - k) * 90.0).to_radians().cos().max(0.0);
                        d.tf = tf0
                            .pre_translate(0.0, ry)
                            .pre_scale(1.0, a.max(0.001))
                            .pre_translate(0.0, -ry);
                        d.opacity = if k > 0.0 { op0 } else { 0.0 };
                    }
                }
                if d.opacity <= 0.001 {
                    d.tf = tf0;
                    d.opacity = op0;
                    continue;
                }
            }
            let look = row_look(&c, st, row);
            let merge = merge_of(&c, &m, row);
            let mut skip_to = 0usize;
            for (j, mc) in m.cols.iter().enumerate() {
                if j < skip_to {
                    continue;
                }
                let mut w = ws[j];
                let mut txt = cell_text(mc, row);
                let mut align = mc.col.align;
                let mut kind = mc.col.kind;
                if let Some((mj, span, mt)) = merge {
                    if mj == j {
                        for k in 1..span {
                            w += ws[j + k] + gap;
                        }
                        skip_to = j + span;
                        if !mt.is_empty() {
                            txt = mt.to_string();
                            kind = ColKind::Text;
                        }
                        align = Align::Center;
                    }
                }
                let (mut bg, mut color) = (look.bg, look.color);
                if !look.hl && c.header_col_on && !mc.rank() && mc.col.src == c.header_col {
                    bg = Draw::hex(&c.st.hcol.bg);
                    color = Draw::hex(&c.st.hcol.color);
                }
                if kind == ColKind::Number && !mc.rank() && c.cf.neg && !look.hl {
                    let v =
                        mc.i.and_then(|i| row.r.get(i))
                            .and_then(|s| cg_core::wid::table::num(s));
                    if v.is_some_and(|v| v < 0.0) {
                        color = Draw::hex(&c.cf.neg_color);
                    }
                }
                if mc.rank() && look.top3 {
                    color = Draw::hex(&c.cf.top3_color);
                }
                if c.cell.on && c.cell.row as usize == row.rank && c.cell.col as usize == j + 1 {
                    bg = Draw::hex(&c.cell.bg);
                    color = Draw::hex(&c.cell.color);
                }
                let x = xs[j];
                rect(d, x, ry, w, rh, 0.0, bg, rm);
                lines(d, x, ry, w, rh, i > 0 || show_head || c.title.on, j > 0, rm);
                if j == 0 && look.top3 {
                    rect(d, x, ry, 8.0, rh, 0.0, Draw::hex(&c.cf.top3_color), rm);
                }
                if j == 0 && look.hl {
                    rect(d, x, ry, 8.0, rh, 0.0, Color::WHITE, rm);
                }
                if kind == ColKind::Image {
                    draw_picture(d, &txt, x + w / 2.0, ry + rh / 2.0, (rh * 0.5).round(), rm);
                    continue;
                }
                let f = if kind == ColKind::Number { &f8 } else { &f7 };
                if let Some(f) = f {
                    let (p, _) = fitted_path(
                        f,
                        &txt,
                        size,
                        0.0,
                        align_of(align),
                        (x + pad, ry, w - 2.0 * pad, rh),
                        Some(fit),
                    );
                    if let Some(p) = p {
                        d.fill(&p, color, FillRule::Winding, rm);
                    }
                }
            }
            d.tf = tf0;
            d.opacity = op0;
        }
    }
    if c.borders.outer.on {
        let bw = c.borders.outer.width;
        let col = Draw::hex(&c.borders.outer.color);
        rect(d, 0.0, 0.0, d.w, bw, 0.0, col, bm);
        rect(d, 0.0, total_h - bw, d.w, bw, 0.0, col, bm);
        rect(d, 0.0, bw, bw, total_h - 2.0 * bw, 0.0, col, bm);
        rect(d, d.w - bw, bw, bw, total_h - 2.0 * bw, 0.0, col, bm);
    }
    if c.indicator && pages > 1 && !scroll && !m.rows.is_empty() {
        indicator(d, page, pages, total_h + 14.0, bm);
    }
    true
}

/// The "● ● 2 / 4" pill under the table, right aligned.
fn indicator(d: &mut Draw, page: usize, pages: usize, top: f32, m: Option<&Mask>) {
    let Some(f) = d.font(FAMILY, 800) else {
        return;
    };
    let label = format!("{} / {}", page + 1, pages);
    let tw = tx::text_width(&f, &label, 24.0, 0.0);
    let dots: f32 = (0..pages)
        .map(|i| if i == page { 30.0 } else { 12.0 })
        .sum::<f32>()
        + 8.0 * pages as f32;
    let h = 24.0 * tx::LINE_HEIGHT + 16.0;
    let w = 16.0 + dots + 6.0 + tw + 16.0;
    let x0 = d.w - w;
    rect(
        d,
        x0,
        top,
        w,
        h,
        24.0,
        Color([11.0 / 255.0, 13.0 / 255.0, 24.0 / 255.0, 0.8]),
        m,
    );
    let mut x = x0 + 16.0;
    for i in 0..pages {
        let dw = if i == page { 30.0 } else { 12.0 };
        let col = if i == page {
            Draw::hex("#ff3b5c")
        } else {
            with_alpha(Color::WHITE, 0.35)
        };
        rect(d, x, top + (h - 12.0) / 2.0, dw, 12.0, 6.0, col, m);
        x += dw + 8.0;
    }
    if let Some(p) = Draw::text_path(
        &f,
        &label,
        24.0,
        0.0,
        TextAlign::Left,
        VerticalAlign::Middle,
        (x - 2.0, top, tw + 2.0, h),
        tx::LINE_HEIGHT,
    ) {
        d.fill(&p, Color::WHITE, FillRule::Winding, m);
    }
}

/// A picture cell: an asset path is drawn at height `h`, a code as a grey chip.
pub(crate) fn draw_picture(d: &mut Draw, v: &str, cx: f32, cy: f32, h: f32, m: Option<&Mask>) {
    let v = v.trim();
    if v.is_empty() {
        return;
    }
    if v.starts_with('/') || v.contains('.') {
        if let Some((iw, ih)) = d.image_size(v) {
            let s = h / ih.max(1) as f32;
            let w = iw as f32 * s;
            let tf = Transform::from_row(s, 0.0, 0.0, s, cx - w / 2.0, cy - h / 2.0);
            d.image(v, tf, 1.0, m);
            return;
        }
    }
    let w = h * 1.5;
    rect(
        d,
        cx - w / 2.0,
        cy - h / 2.0,
        w,
        h,
        h * 0.1,
        Draw::hex("#334155"),
        m,
    );
    let code: String = v.chars().take(3).collect::<String>().to_uppercase();
    if let Some(f) = d.font(FAMILY, 700) {
        if let Some(p) = Draw::text_path(
            &f,
            &code,
            h * 0.35,
            0.0,
            TextAlign::Center,
            VerticalAlign::Middle,
            (cx - w / 2.0, cy - h / 2.0, w, h),
            tx::LINE_HEIGHT,
        ) {
            d.fill(&p, Draw::hex("#cbd5e1"), FillRule::Winding, m);
        }
    }
}
