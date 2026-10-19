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
use cg_core::{LayerKind, Prop, TextAlign, TextDecoration, VerticalAlign};
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
        x: c,
        ..
    } = &d.layer.kind
    else {
        return false;
    };
    if !scroll.is_none() {
        return false;
    }
    let Some(content) = d.r.text.clone().filter(|t| !t.trim().is_empty()) else {
        return true; // empty: nothing on air, the box keeps its size
    };
    let Some(main) = paint::main_font(d, font_family, *font_weight) else {
        return true;
    };
    let chain = paint::chain(d, main.clone(), &content);
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
    let fit = tx::fit_lines(&content, &opts, &mut |s, z| {
        tx::chain_width(&chain, s, z, ls)
    });
    let (size, sx) = (fit.size, fit.squeeze);
    let rtl = c.dir == Direction::Rtl;
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

    let clip = if fit.clip { d.boxed() } else { None };
    let mask = clip.as_ref();
    let mut text_pb = PathBuilder::new();
    let mut deco_pb = PathBuilder::new();
    let mut pictures = Vec::new();
    let mut bands = Vec::new();
    for (i, l) in fit.lines.iter().enumerate() {
        let shown = if rtl {
            tx::visual_rtl(&l.text)
        } else {
            l.text.clone()
        };
        let spaces = shown.chars().filter(|ch| *ch == ' ').count();
        let w = tx::chain_width(&chain, &shown, size, ls);
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
            _ if justified => 0.0,
            TextAlign::Left => 0.0,
            TextAlign::Center => (bw - lw) / 2.0,
            TextAlign::Right => bw - lw,
        };
        let baseline = top + i as f32 * line_h + half + asc;
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
        // Underline / strike through, as layout_text draws them.
        let bar = match decoration {
            TextDecoration::Underline => Some(baseline + size * 0.1),
            TextDecoration::LineThrough => Some(baseline - size * 0.3),
            TextDecoration::None => None,
        };
        let (lx, lwx) = (pad + x * sx, lw * sx);
        if let (Some(y), true) = (bar, lw > 0.0) {
            let t = (size * 0.06).max(1.0);
            if let Some(r) = tiny_skia::Rect::from_xywh(lx, y - t / 2.0, lwx, t) {
                deco_pb.push_rect(r);
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
    let Some(path) = text_pb.finish() else {
        draw_pictures(d, &chain, &pictures, size, sx, mask);
        return true;
    };
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
            &[&path],
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
        d.stroke(&path, stroke_col, &s, mask);
    }
    match c.fill_type {
        FillType::Solid => d.fill(&path, d.color(Prop::Fill), FillRule::Winding, mask),
        FillType::Gradient => {
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
                d.fill_paint(&path, &p, FillRule::Winding, mask);
            }
        }
    }
    if !c.stroke_outside && sw > 0.0 {
        let s = Stroke {
            width: sw,
            ..Default::default()
        };
        d.stroke(&path, stroke_col, &s, mask);
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
