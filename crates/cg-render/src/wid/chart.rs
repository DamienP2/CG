//! Chart: drawing (same picture as `web/src/widgets/chart.tsx`). The layout
//! (shapes and texts) comes from `cg_core::wid::chart::layout`.

use ab_glyph::{Font, ScaleFont};
use cg_core::wid::chart::{
    layout, shown_grid, with_data, Anchor, Input, PShape, PText, Prim, State,
};
use cg_core::{Color, LayerKind, Prop, TextAlign, VerticalAlign};
use tiny_skia::{FillRule, LineCap, LineJoin, Stroke, StrokeDash, Transform};

use super::{shape, Draw};
use crate::text as tx;

fn col(s: &str, op: f32) -> Color {
    let mut c = Draw::hex(s);
    c.0[3] *= op.clamp(0.0, 1.0);
    c
}

fn draw_shape(d: &mut Draw, s: &PShape) {
    let Some(path) = shape::path(&s.d) else {
        return;
    };
    let mask = s.clip.and_then(|c| d.clip(c[0], c[1], c[2], c[3]));
    if let Some(f) = &s.fill {
        d.fill(
            &path,
            col(f, s.opacity * s.fill_opacity),
            FillRule::Winding,
            mask.as_ref(),
        );
    }
    if let Some(st) = &s.stroke {
        if s.width > 0.0 {
            let mut k = Stroke {
                width: s.width,
                ..Default::default()
            };
            if s.round {
                k.line_join = LineJoin::Round;
                k.line_cap = LineCap::Round;
            }
            if let Some([a, b]) = s.dash {
                k.dash = StrokeDash::new(vec![a, b], 0.0);
            }
            d.stroke(&path, col(st, s.opacity), &k, mask.as_ref());
        }
    }
}

fn draw_text(d: &mut Draw, t: &PText) {
    if t.text.is_empty() || t.opacity <= 0.0 {
        return;
    }
    let Some(font) = d.font("Inter", t.weight) else {
        return;
    };
    // Baseline of a top-aligned line of the text layout.
    let upem = font.units_per_em().unwrap_or(1000.0);
    let scaled = font.as_scaled(ab_glyph::PxScale::from(
        t.size * font.height_unscaled() / upem,
    ));
    let base =
        (t.size * tx::LINE_HEIGHT - (scaled.ascent() - scaled.descent())) / 2.0 + scaled.ascent();
    let w = Draw::text_width(&font, &t.text, t.size, 0.0);
    let x0 = match t.anchor {
        Anchor::Start => 0.0,
        Anchor::Middle => -w / 2.0,
        Anchor::End => -w,
    };
    let Some(mut p) = Draw::text_path(
        &font,
        &t.text,
        t.size,
        0.0,
        TextAlign::Left,
        VerticalAlign::Top,
        (x0, -base, w + 10.0, t.size * 2.0),
        tx::LINE_HEIGHT,
    ) else {
        return;
    };
    let tf = if t.rotate {
        Transform::from_rotate(-90.0).post_translate(t.x, t.y)
    } else {
        Transform::from_translate(t.x, t.y)
    };
    let Some(pp) = p.clone().transform(tf) else {
        return;
    };
    p = pp;
    let mask = t.clip.and_then(|c| d.clip(c[0], c[1], c[2], c[3]));
    if let Some(h) = &t.halo {
        let k = Stroke {
            width: 5.0,
            line_join: LineJoin::Round,
            ..Default::default()
        };
        d.stroke(&p, col(h, t.opacity), &k, mask.as_ref());
    }
    d.fill(
        &p,
        col(&t.fill, t.opacity),
        FillRule::Winding,
        mask.as_ref(),
    );
}

pub(crate) fn draw(d: &mut Draw, st: &State) -> bool {
    let LayerKind::Chart { x: c } = &d.layer.kind else {
        return false;
    };
    let grid = shown_grid(c, st, d.data);
    let c = with_data(c, d.data);
    let out = layout(&Input {
        cfg: &c,
        st,
        grid: &grid,
        w: d.w,
        h: d.h,
        fs: d.num(Prop::FontSize),
        age_ms: (d.time.age_secs * 1000.0) as f32,
        now: d.time.now_ms,
    });
    for p in &out.prims {
        match p {
            Prim::Shape(s) => draw_shape(d, s),
            Prim::Text(t) => draw_text(d, t),
        }
    }
    true
}
