//! Text: drawing (same picture as `web/src/widgets/text.tsx`).
//!
//! The fit chain is `text::fit_lines` (the web's `fitLines`); then every
//! line is drawn with the fallback fonts (never an empty box: colour emoji
//! as pictures), its band, shadow, stroke and fill. A scrolling text is left
//! to the ticker / roll code (lib.rs).
//!
//! No text shaping: Arabic letters are drawn in their isolated forms (the
//! browser joins them); right-to-left lines are put in visual order.

#[path = "text_draw.rs"]
pub(crate) mod paint;

use cg_core::wid::text::{BreakMode, Direction, FillType, FitEnd, State};
use cg_core::widgets::scroll_positions;
use cg_core::{
    LayerKind, Prop, TextAlign, TextDecoration, TextOverflow, TextScroll, VerticalAlign,
};
use tiny_skia::{FillRule, Paint, PathBuilder, Stroke};

use super::{rrect, Draw};
use crate::text::{self as tx, FitOpts};

pub(crate) fn draw(d: &mut Draw, _st: &State) -> bool {
    let LayerKind::Text {
        font_family,
        font_weight,
        align,
        vertical_align,
        wrap,
        decoration,
        line_height,
        overflow,
        squeeze,
        min_size,
        scroll,
        speed,
        separator,
        looping,
        x: c,
        ..
    } = &d.layer.kind
    else {
        return false;
    };
    let Some(content) = d.r.text.clone().filter(|t| !t.trim().is_empty()) else {
        return true; // empty: nothing on air, the box keeps its size
    };
    // Scrolling: a ticker (the lines one after the other, with the
    // separator) or a roll (the lines going up), with all the text's looks.
    let scrolling = !scroll.is_none();
    let horizontal = *scroll == TextScroll::Horizontal;
    let content = if horizontal {
        content.replace('\n', separator) + separator
    } else {
        content
    };
    let Some(main) = paint::main_font(d, font_family, *font_weight) else {
        return true;
    };
    let chain = paint::chain(d, main.clone(), &content);
    let rtl = c.dir == Direction::Rtl;
    // Styled parts (not for right-to-left lines, drawn in visual order).
    let runs = d.runs.clone().filter(|_| !rtl).map(|mut r| {
        if horizontal {
            for x in &mut r {
                x.text = x.text.replace('\n', separator);
            }
            if let Some(last) = r.last_mut() {
                last.text.push_str(separator);
            }
        }
        r
    });
    let bold = runs
        .as_ref()
        .filter(|r| r.iter().any(|r| r.style.bold))
        .and_then(|_| paint::main_font(d, font_family, ((*font_weight).max(400) + 300).min(900)))
        .map(|f| paint::chain(d, f, &content));
    let size0 = d.num(Prop::FontSize);
    let ls = d.num(Prop::LetterSpacing);
    let lh = line_height.unwrap_or(tx::LINE_HEIGHT);
    let pad = if c.band { c.band_pad_x.max(0.0) } else { 0.0 };
    let avail = if c.band {
        (d.w - 2.0 * pad).max(20.0)
    } else {
        d.w
    };
    let opts = FitOpts {
        size: size0,
        line_height: lh,
        box_w: avail,
        box_h: d.h,
        wrap: *wrap,
        overflow: *overflow,
        squeeze: *squeeze,
        min_size: *min_size,
        max_lines: c.max_lines as usize,
        hyphen: c.break_mode == BreakMode::Hyphen,
        lang: if c.lang.is_empty() { d.lang } else { &c.lang },
        ellipsis_end: c.fit_end == FitEnd::Ellipsis,
    };
    // With bold parts, measured in bold: the lines never get wider than the box.
    let measure = bold.as_ref().unwrap_or(&chain);
    let fit = if horizontal {
        tx::FitLines {
            lines: vec![tx::FitLine {
                text: content.clone(),
                end: true,
            }],
            size: size0,
            squeeze: 1.0,
            clip: true,
            ratio: 1.0,
            overflows: false,
            stage: "fit",
            forced: false,
            hyphenated: false,
        }
    } else if scrolling {
        // A roll: every line at its size, however long it is.
        let o = FitOpts {
            box_h: f32::MAX / 4.0,
            overflow: TextOverflow::Visible,
            ..opts
        };
        let mut f = tx::fit_lines(&content, &o, &mut |s, z| tx::chain_width(measure, s, z, ls));
        f.clip = true;
        f
    } else {
        tx::fit_lines(&content, &opts, &mut |s, z| {
            tx::chain_width(measure, s, z, ls)
        })
    };
    let (size, sx) = (fit.size, fit.squeeze);
    let parts = runs.as_ref().map(|r| {
        let lines: Vec<&str> = fit.lines.iter().map(|l| l.text.as_str()).collect();
        cg_core::rich::align(r, &lines)
    });
    let bw = avail / sx; // the box the lines are aligned in, before squeezing
    let line_h = size * lh;
    let n = fit.lines.len();
    let top = match vertical_align {
        VerticalAlign::Top => 0.0,
        VerticalAlign::Middle => (d.h - line_h * n as f32) / 2.0,
        VerticalAlign::Bottom => d.h - line_h * n as f32,
    };
    let (asc, desc) = tx::metrics(&main, size);
    let half = (line_h - (asc - desc)) / 2.0;
    // Where the text is drawn: once, or each copy of a scroll on its way.
    let travelled = speed * d.time.age_secs;
    let placements: Vec<(f32, f32)> = if horizontal {
        let cycle = tx::chain_width(measure, &content, size, ls) + ls;
        scroll_positions(d.w as f64, cycle as f64, travelled, true)
            .into_iter()
            .map(|x| (x as f32, 0.0))
            .collect()
    } else if scrolling {
        let block = line_h * n as f32;
        // A screen-high gap before the roll comes round again.
        let cycle = if *looping { block + d.h } else { block };
        scroll_positions(d.h as f64, cycle as f64, travelled, *looping)
            .into_iter()
            .map(|y| (0.0, y as f32 - top))
            .collect()
    } else {
        vec![(0.0, 0.0)]
    };

    let clip = if fit.clip { d.boxed() } else { None };
    let mask = clip.as_ref();
    let mut text_pb = PathBuilder::new();
    let mut deco_pb = PathBuilder::new();
    // Parts in their own colour: (colour, glyphs and lines).
    let mut colored: Vec<(String, PathBuilder)> = Vec::new();
    let mut pictures = Vec::new();
    let mut bands = Vec::new();
    for &(ox, oy) in &placements {
        let top = top + oy;
        for (i, l) in fit.lines.iter().enumerate() {
            let shown = if rtl {
                tx::visual_rtl(&l.text)
            } else {
                l.text.clone()
            };
            let spaces = shown.chars().filter(|ch| *ch == ' ').count();
            let segs = parts.as_ref().map(|p| &p[i]);
            let chain_of = |run: usize| {
                let styled = runs.as_ref().map(|r| &r[run].style);
                match (styled.is_some_and(|s| s.bold), &bold) {
                    (true, Some(b)) => b,
                    _ => &chain,
                }
            };
            let w = match segs {
                Some(segs) => segs
                    .iter()
                    .map(|(t, run)| tx::chain_width(chain_of(*run), t, size, ls))
                    .sum(),
                None => tx::chain_width(&chain, &shown, size, ls),
            };
            let justified = c.justify && !l.end && spaces > 0 && w < bw;
            let extra = if justified {
                (bw - w) / spaces as f32
            } else {
                0.0
            };
            let lw = if justified { bw } else { w };
            let eff = if c.justify && !justified {
                if rtl {
                    TextAlign::Right
                } else {
                    TextAlign::Left
                }
            } else {
                *align
            };
            let x = match eff {
                _ if horizontal => ox,
                _ if justified => 0.0,
                TextAlign::Left => 0.0,
                TextAlign::Center => (bw - lw) / 2.0,
                TextAlign::Right => bw - lw,
            };
            let baseline = top + i as f32 * line_h + half + asc;
            let (lx, lwx) = (pad + x * sx, lw * sx);
            let thick = (size * 0.06).max(1.0);
            let bar = |pb: &mut PathBuilder, y: f32, x0: f32, w: f32| {
                if let Some(r) = tiny_skia::Rect::from_xywh(x0, y - thick / 2.0, w, thick) {
                    pb.push_rect(r);
                }
            };
            // Underline / strike through, as layout_text draws them.
            let under = baseline + size * 0.1;
            let through = baseline - size * 0.3;
            match segs {
                // One part after the other, each in its style.
                Some(segs) => {
                    let mut px = pad + x;
                    for (t, run) in segs {
                        let st = &runs.as_ref().expect("parts come from runs")[*run].style;
                        let lp = paint::line(
                            chain_of(*run),
                            t,
                            size,
                            ls,
                            extra,
                            px,
                            baseline,
                            sx,
                            pad,
                            if c.italic || st.italic { 0.25 } else { 0.0 },
                        );
                        let pb = match &st.color {
                            Some(col) => match colored.iter().position(|(c, _)| c == col) {
                                Some(k) => &mut colored[k].1,
                                None => {
                                    colored.push((col.clone(), PathBuilder::new()));
                                    &mut colored.last_mut().expect("pushed").1
                                }
                            },
                            None => &mut text_pb,
                        };
                        if let Some(p) = &lp.path {
                            pb.push_path(p);
                        }
                        let (sx0, sw0) = (pad + (px - pad) * sx, lp.width * sx);
                        if sw0 > 0.0 {
                            if st.underline || *decoration == TextDecoration::Underline {
                                bar(pb, under, sx0, sw0);
                            }
                            if st.strike || *decoration == TextDecoration::LineThrough {
                                bar(pb, through, sx0, sw0);
                            }
                        }
                        pictures.extend(lp.pictures);
                        px += lp.width;
                    }
                }
                None => {
                    let lp = paint::line(
                        &chain,
                        &shown,
                        size,
                        ls,
                        extra,
                        pad + x,
                        baseline,
                        sx,
                        pad,
                        if c.italic { 0.25 } else { 0.0 },
                    );
                    if let Some(p) = &lp.path {
                        text_pb.push_path(p);
                    }
                    pictures.extend(lp.pictures);
                    let y = match decoration {
                        TextDecoration::Underline => Some(under),
                        TextDecoration::LineThrough => Some(through),
                        TextDecoration::None => None,
                    };
                    if let (Some(y), true) = (y, lw > 0.0) {
                        bar(&mut deco_pb, y, lx, lwx);
                    }
                }
            }
            if c.band && !l.text.trim().is_empty() {
                bands.push((
                    lx - pad,
                    top + i as f32 * line_h + c.band_gap / 2.0,
                    lwx + 2.0 * pad,
                    (line_h - c.band_gap).max(4.0),
                ));
            }
        }
    }
    if let Some(dp) = deco_pb.finish() {
        text_pb.push_path(&dp);
    }
    // Bands behind the lines.
    let band_col = Draw::hex(&c.band_color);
    let accent = Draw::hex(&c.band_accent_color);
    for (bx, by, bwid, bh) in &bands {
        if let Some(p) = rrect(*bx, *by, *bwid, *bh, c.band_radius) {
            d.fill(&p, band_col, FillRule::Winding, mask);
            if c.band_accent {
                let ax = if rtl { bx + bwid - 8.0 } else { *bx };
                if let Some(m) = d.clip(ax, *by, 8.0, *bh).map(|m| combine(&m, mask)) {
                    d.fill(&p, accent, FillRule::Winding, Some(&m));
                }
            }
        }
    }
    let colored: Vec<(cg_core::Color, tiny_skia::Path)> = colored
        .into_iter()
        .filter_map(|(c, pb)| Some((Draw::hex(&c), pb.finish()?)))
        .collect();
    let path = text_pb.finish();
    if path.is_none() && colored.is_empty() {
        draw_pictures(d, &chain, &pictures, size, sx, mask);
        return true;
    }
    // Shadow and strokes go around every part, whatever its colour.
    let all: Vec<&tiny_skia::Path> = path.iter().chain(colored.iter().map(|(_, p)| p)).collect();
    let sw = d.num(Prop::StrokeWidth);
    let stroke_col = d.color(Prop::Stroke);
    if c.shadow {
        let st = if c.stroke_outside && sw > 0.0 {
            sw * 2.0
        } else {
            0.0
        };
        paint::shadow(
            d,
            &all,
            st,
            Draw::hex(&c.shadow_color),
            c.shadow_x,
            c.shadow_y,
            c.shadow_blur,
            mask,
        );
    }
    if c.stroke_outside && sw > 0.0 {
        let s = Stroke {
            width: sw * 2.0,
            line_join: tiny_skia::LineJoin::Round,
            ..Default::default()
        };
        for p in &all {
            d.stroke(p, stroke_col, &s, mask);
        }
    }
    for (col, p) in &colored {
        d.fill(p, *col, FillRule::Winding, mask);
    }
    match (c.fill_type, &path) {
        (_, None) => {}
        (FillType::Solid, Some(path)) => d.fill(path, d.color(Prop::Fill), FillRule::Winding, mask),
        (FillType::Gradient, Some(path)) => {
            if let Some(shader) = paint::gradient(
                d.color(Prop::Fill),
                Draw::hex(&c.color2),
                c.grad_angle,
                d.w.max(1.0),
                d.h.max(1.0),
                d.opacity,
            ) {
                let p = Paint {
                    shader,
                    anti_alias: true,
                    ..Default::default()
                };
                d.fill_paint(path, &p, FillRule::Winding, mask);
            }
        }
    }
    if !c.stroke_outside && sw > 0.0 {
        let s = Stroke {
            width: sw,
            ..Default::default()
        };
        for p in &all {
            d.stroke(p, stroke_col, &s, mask);
        }
    }
    draw_pictures(d, &chain, &pictures, size, sx, mask);
    true
}

fn draw_pictures(
    d: &mut Draw,
    chain: &tx::Chain,
    pics: &[(tx::PGlyph, f32, f32)],
    size: f32,
    sx: f32,
    mask: Option<&tiny_skia::Mask>,
) {
    for (g, x, baseline) in pics {
        paint::picture(d, chain, g, *x, *baseline, size, sx, 1.0, mask);
    }
}

/// `a` ∩ `b` (b optional).
fn combine(a: &tiny_skia::Mask, b: Option<&tiny_skia::Mask>) -> tiny_skia::Mask {
    let mut m = a.clone();
    if let Some(b) = b {
        for (x, y) in m.data_mut().iter_mut().zip(b.data()) {
            *x = ((*x as u16 * *y as u16) / 255) as u8;
        }
    }
    m
}
