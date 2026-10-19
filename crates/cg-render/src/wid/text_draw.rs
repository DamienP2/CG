//! Drawing helpers of the text widgets (Text, Typewriter, Counter): lines of
//! glyphs with fallback fonts and colour emoji, gradients, blurred shadows.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use ab_glyph::Font;
use cg_core::Color;
use tiny_skia::{
    FillRule, GradientStop, LinearGradient, Mask, Paint, Path, PathBuilder, Pixmap, PixmapPaint,
    Point, Shader, SpreadMode, Stroke, Transform,
};

use super::Draw;
use crate::text::{self as tx, Chain, PGlyph};

pub(crate) fn sk(c: Color, opacity: f32) -> tiny_skia::Color {
    let [r, g, b, a] = c.0;
    tiny_skia::Color::from_rgba(
        r.clamp(0.0, 1.0),
        g.clamp(0.0, 1.0),
        b.clamp(0.0, 1.0),
        (a * opacity).clamp(0.0, 1.0),
    )
    .unwrap_or(tiny_skia::Color::TRANSPARENT)
}

/// A CSS `linear-gradient(angle, c1, c2)` over the box (0, 0, w, h).
pub(crate) fn gradient(
    c1: Color,
    c2: Color,
    angle: f32,
    w: f32,
    h: f32,
    opacity: f32,
) -> Option<Shader<'static>> {
    let a = (angle - 90.0).to_radians();
    let (dx, dy) = (a.cos() / 2.0, a.sin() / 2.0);
    let len = (w * dx.abs() + h * dy.abs()) * 2.0;
    let (cx, cy) = (w / 2.0, h / 2.0);
    LinearGradient::new(
        Point::from_xy(cx - dx * len, cy - dy * len),
        Point::from_xy(cx + dx * len, cy + dy * len),
        vec![
            GradientStop::new(0.0, sk(c1, opacity)),
            GradientStop::new(1.0, sk(c2, opacity)),
        ],
        SpreadMode::Pad,
        Transform::identity(),
    )
}

/// One line laid out: its outline (layer space) and its colour pictures.
pub(crate) struct LinePaint {
    pub path: Option<Path>,
    pub pictures: Vec<(PGlyph, f32, f32)>,
    pub width: f32,
}

/// Outline of `line` with its left at `x`, baseline `baseline`, squeezed
/// horizontally by `sx` from `x_origin` (1 = not squeezed), slanted by
/// `skew` (synthetic italic, like browsers: 0.25).
#[allow(clippy::too_many_arguments)]
pub(crate) fn line(
    chain: &Chain,
    line: &str,
    size: f32,
    ls: f32,
    space_extra: f32,
    x: f32,
    baseline: f32,
    sx: f32,
    x_origin: f32,
    skew: f32,
) -> LinePaint {
    let (glyphs, width) = tx::glyph_run(chain, line, size, ls, space_extra);
    let mut pb = PathBuilder::new();
    let pics = tx::run_outline(chain, &glyphs, size, x, baseline, &mut pb);
    let squeeze = Transform::from_row(
        sx,
        0.0,
        -skew,
        1.0,
        x_origin * (1.0 - sx) + skew * baseline,
        0.0,
    );
    let path = pb.finish().and_then(|p| {
        if sx == 1.0 && skew == 0.0 {
            Some(p)
        } else {
            p.transform(squeeze)
        }
    });
    let pictures = pics
        .into_iter()
        .map(|g| (g, x_origin + (x + g.x - x_origin) * sx, baseline))
        .collect();
    LinePaint {
        path,
        pictures,
        width,
    }
}

thread_local! {
    static PICS: RefCell<HashMap<(usize, u16, u16), Option<(Arc<Pixmap>, f32, f32, u16)>>> = RefCell::new(HashMap::new());
}

/// Draws a colour glyph (emoji) at pen (x, baseline), `size` px, squeezed by `sx`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn picture(
    d: &mut Draw,
    chain: &Chain,
    g: &PGlyph,
    x: f32,
    baseline: f32,
    size: f32,
    sx: f32,
    alpha: f32,
    mask: Option<&Mask>,
) {
    let font = &chain.fonts[g.font];
    let scale = (d.tf.sx * d.tf.sx + d.tf.ky * d.tf.ky).sqrt().max(0.01);
    let want = (size * scale).round().clamp(8.0, 512.0) as u16;
    let key = (font.font_data().as_ptr() as usize, g.id.0, want);
    let pic = PICS.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() > 600 {
            m.clear();
        }
        m.entry(key)
            .or_insert_with(|| {
                let img = font.glyph_raster_image2(g.id, want)?;
                if !matches!(img.format, ab_glyph::GlyphImageFormat::Png) {
                    return None;
                }
                let rgba = image::load_from_memory_with_format(img.data, image::ImageFormat::Png)
                    .ok()?
                    .to_rgba8();
                let (w, h) = rgba.dimensions();
                let mut data = rgba.into_raw();
                for px in data.as_chunks_mut::<4>().0 {
                    let a = px[3] as u16;
                    for c in &mut px[..3] {
                        *c = ((*c as u16 * a + 127) / 255) as u8;
                    }
                }
                let pm = Pixmap::from_vec(data, tiny_skia::IntSize::from_wh(w, h)?)?;
                Some((Arc::new(pm), img.origin.x, img.origin.y, img.pixels_per_em))
            })
            .clone()
    });
    let Some((pm, ox, oy, ppem)) = pic else {
        return;
    };
    let k = size / ppem.max(1) as f32;
    let h = pm.height() as f32;
    let tf =
        d.tf.pre_translate(x + ox * k * sx, baseline - (oy + h) * k)
            .pre_scale(k * sx, k);
    let paint = PixmapPaint {
        opacity: alpha * d.opacity,
        quality: tiny_skia::FilterQuality::Bicubic,
        ..Default::default()
    };
    d.pm.draw_pixmap(0, 0, pm.as_ref().as_ref(), &paint, tf, mask.or(d.mask));
}

/// Draws `paths` (filled; `stroke`: also stroked that wide) in `color`,
/// blurred by `blur` px and offset by (dx, dy), like a CSS drop shadow.
#[allow(clippy::too_many_arguments)]
pub(crate) fn shadow(
    d: &mut Draw,
    paths: &[&Path],
    stroke: f32,
    color: Color,
    dx: f32,
    dy: f32,
    blur: f32,
    mask: Option<&Mask>,
) {
    let tf = d.tf.pre_translate(dx, dy);
    let scale = (d.tf.sx * d.tf.sx + d.tf.ky * d.tf.ky).sqrt().max(0.01);
    let sigma = (blur * scale / 2.0).max(0.0);
    let margin = (sigma * 3.0 + stroke * scale + 2.0).ceil();
    let mut bounds: Option<tiny_skia::Rect> = None;
    for p in paths {
        if let Some(b) = (*p).clone().transform(tf).map(|p| p.bounds()) {
            bounds = Some(match bounds {
                None => b,
                Some(a) => tiny_skia::Rect::from_ltrb(
                    a.left().min(b.left()),
                    a.top().min(b.top()),
                    a.right().max(b.right()),
                    a.bottom().max(b.bottom()),
                )
                .unwrap_or(a),
            });
        }
    }
    let Some(b) = bounds else {
        return;
    };
    let x0 = (b.left() - margin).floor().max(0.0);
    let y0 = (b.top() - margin).floor().max(0.0);
    let x1 = (b.right() + margin).ceil().min(d.pm.width() as f32);
    let y1 = (b.bottom() + margin).ceil().min(d.pm.height() as f32);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let Some(mut off) = Pixmap::new((x1 - x0) as u32, (y1 - y0) as u32) else {
        return;
    };
    let mut paint = Paint::default();
    paint.set_color(sk(color, 1.0));
    paint.anti_alias = true;
    let local = tf.post_translate(-x0, -y0);
    for p in paths {
        off.fill_path(p, &paint, FillRule::Winding, local, None);
        if stroke > 0.0 {
            let s = Stroke {
                width: stroke,
                line_join: tiny_skia::LineJoin::Round,
                ..Default::default()
            };
            off.stroke_path(p, &paint, &s, local, None);
        }
    }
    if sigma > 0.3 {
        blur_pixmap(&mut off, sigma);
    }
    let pp = PixmapPaint {
        opacity: d.opacity,
        ..Default::default()
    };
    d.pm.draw_pixmap(
        x0 as i32,
        y0 as i32,
        off.as_ref(),
        &pp,
        Transform::identity(),
        mask.or(d.mask),
    );
}

/// Three box blurs ≈ a Gaussian of `sigma` (premultiplied RGBA).
fn blur_pixmap(pm: &mut Pixmap, sigma: f32) {
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let size = ((12.0 * sigma * sigma / 3.0 + 1.0).sqrt()).max(1.0);
    let r = ((size - 1.0) / 2.0).round().max(1.0) as usize;
    let data = pm.data_mut();
    let mut tmp = vec![0u8; data.len()];
    for _ in 0..3 {
        box_pass(data, &mut tmp, w, h, r, true);
        box_pass(&tmp, data, w, h, r, false);
    }
}

fn box_pass(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool) {
    let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
    let idx = |o: usize, i: usize| {
        if horizontal {
            (o * w + i) * 4
        } else {
            (i * w + o) * 4
        }
    };
    let div = (2 * r + 1) as u32;
    for o in 0..outer {
        let mut acc = [0u32; 4];
        for i in 0..=r.min(inner - 1) {
            let p = idx(o, i);
            for c in 0..4 {
                acc[c] += src[p + c] as u32;
            }
        }
        for i in 0..inner {
            let p = idx(o, i);
            for c in 0..4 {
                dst[p + c] = (acc[c] / div).min(255) as u8;
            }
            if i + r + 1 < inner {
                let q = idx(o, i + r + 1);
                for c in 0..4 {
                    acc[c] += src[q + c] as u32;
                }
            }
            if i >= r {
                let q = idx(o, i - r);
                for c in 0..4 {
                    acc[c] -= src[q + c] as u32;
                }
            }
        }
    }
}

/// The text's font, falling back to Inter (italic is synthesized, as the
/// browser does with the fonts the server serves).
pub(crate) fn main_font(d: &mut Draw, family: &str, weight: u16) -> Option<ab_glyph::FontArc> {
    d.rd.fonts
        .font(family, weight)
        .or_else(|| d.rd.fonts.font("Inter", weight))
}

/// A chain for `text` (and "…", "-", the cursor's characters).
pub(crate) fn chain(d: &mut Draw, main: ab_glyph::FontArc, text: &str) -> Chain {
    Chain::new(&mut d.rd.fonts, main, &format!("{text}…-"))
}
