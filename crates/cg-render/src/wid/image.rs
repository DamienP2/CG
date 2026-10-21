//! Image: drawing (same picture as `web/src/widgets/image.tsx`).
//! Pictures are decoded once by the renderer's cache; a colorized copy is
//! made once per (picture, mode, colour) and kept here, never per frame.

use std::collections::HashMap;
use std::sync::Mutex;

use cg_core::anim::interpolate_text;
use cg_core::wid::image::{crop, fit, frame_rect, place, seq, Colorize, Config, Crop, Fit, State};
use cg_core::{Color, LayerKind, Prop};
use tiny_skia::{
    FillRule, GradientStop, LineCap, LineJoin, LinearGradient, Mask, Paint, PathBuilder, Pixmap,
    PixmapPaint, Point, Rect, SpreadMode, Stroke, Transform,
};

use super::{rrect, Draw};
use crate::paint_for;

/// Colorized copies of pictures (key: source, mode, colour).
static TINTED: Mutex<Option<HashMap<String, Pixmap>>> = Mutex::new(None);

/// The reloads each renderer has done, by (renderer, layer).
static RELOADED: Mutex<Option<HashMap<(usize, String), u32>>> = Mutex::new(None);

/// The operator reloaded the picture: it is read again from the disk once.
fn reload(d: &mut Draw, st: &State, src: &str) {
    if st.reload == 0 {
        return;
    }
    let key = (std::ptr::from_ref(&*d.rd) as usize, d.layer.id.clone());
    let mut seen = RELOADED.lock().unwrap_or_else(|e| e.into_inner());
    let map = seen.get_or_insert_with(HashMap::new);
    if map.get(&key) == Some(&st.reload) {
        return;
    }
    map.insert(key, st.reload);
    drop(seen);
    d.rd.images.remove(src);
    let prefix = format!("{src}|");
    if let Some(m) = TINTED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        m.retain(|k, _| !k.starts_with(&prefix));
    }
}

fn colorized(src: &Pixmap, mode: Colorize, tint: Color) -> Pixmap {
    let mut out = src.clone();
    let [tr, tg, tb, _] = tint.0;
    for px in out.data_mut().as_chunks_mut::<4>().0 {
        let a = px[3] as f32;
        match mode {
            // Every opaque pixel takes the colour (alpha kept).
            Colorize::Replace => {
                px[0] = (tr.clamp(0.0, 1.0) * a).round() as u8;
                px[1] = (tg.clamp(0.0, 1.0) * a).round() as u8;
                px[2] = (tb.clamp(0.0, 1.0) * a).round() as u8;
            }
            // Greys × the colour (premultiplied stays premultiplied).
            Colorize::Tint => {
                let l = 0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32;
                px[0] = (l * tr.clamp(0.0, 1.0)).round().min(a) as u8;
                px[1] = (l * tg.clamp(0.0, 1.0)).round().min(a) as u8;
                px[2] = (l * tb.clamp(0.0, 1.0)).round().min(a) as u8;
            }
            Colorize::None => {}
        }
    }
    out
}

/// A mask of `path` (layer space) inside the parents' clip.
fn path_mask(d: &Draw, path: &tiny_skia::Path) -> Option<Mask> {
    let mut m = Mask::new(d.pm.width(), d.pm.height())?;
    m.fill_path(path, FillRule::Winding, true, d.tf);
    if let Some(parent) = d.mask {
        for (a, b) in m.data_mut().iter_mut().zip(parent.data()) {
            *a = ((*a as u16 * *b as u16 + 127) / 255) as u8;
        }
    }
    Some(m)
}

/// The built-in slate (when neither the picture nor the fallback exist):
/// neutral, branded, never an error on air. Same drawing as the web's.
fn slate(d: &mut Draw, [x, y, w, h]: [f32; 4], mask: &Mask) {
    let Some(r) = Rect::from_xywh(x, y, w.max(1.0), h.max(1.0)) else {
        return;
    };
    let path = PathBuilder::from_rect(r);
    let c1 = tiny_skia::Color::from_rgba8(0x1b, 0x14, 0x42, (255.0 * d.opacity) as u8);
    let c2 = tiny_skia::Color::from_rgba8(0x3b, 0x0d, 0x2a, (255.0 * d.opacity) as u8);
    if let Some(shader) = LinearGradient::new(
        Point::from_xy(x, y),
        Point::from_xy(x + w, y + h),
        vec![GradientStop::new(0.0, c1), GradientStop::new(1.0, c2)],
        SpreadMode::Pad,
        Transform::identity(),
    ) {
        let paint = Paint {
            shader,
            anti_alias: true,
            ..Default::default()
        };
        d.pm.fill_path(&path, &paint, FillRule::Winding, d.tf, Some(mask));
    }
    let s = w.min(h);
    let (cx, cy, rr) = (x + w / 2.0, y + h / 2.0, s * 0.2);
    if let Some(ring) = PathBuilder::from_circle(cx, cy, rr) {
        let st = Stroke {
            width: s * 0.045,
            ..Default::default()
        };
        d.pm.stroke_path(
            &ring,
            &paint_for(Color::WHITE, d.opacity),
            &st,
            d.tf,
            Some(mask),
        );
    }
    let mut pb = PathBuilder::new();
    for (i, (u, v)) in SLATE_PULSE.iter().enumerate() {
        let (px, py) = (cx + u * rr, cy + v * rr);
        if i == 0 {
            pb.move_to(px, py);
        } else {
            pb.line_to(px, py);
        }
    }
    if let Some(p) = pb.finish() {
        let st = Stroke {
            width: s * 0.038,
            line_cap: LineCap::Round,
            line_join: LineJoin::Round,
            ..Default::default()
        };
        let red = Color::from_hex("#ff3b5c").unwrap_or(Color::WHITE);
        d.pm.stroke_path(&p, &paint_for(red, d.opacity), &st, d.tf, Some(mask));
    }
}

/// The pulse line of the slate, in ring radii from its centre.
const SLATE_PULSE: [(f32, f32); 7] = [
    (-0.73, 0.08),
    (-0.36, 0.08),
    (-0.19, -0.4),
    (0.02, 0.52),
    (0.23, -0.6),
    (0.42, 0.08),
    (0.75, 0.08),
];

pub(crate) fn draw(d: &mut Draw, st: &State) -> bool {
    let LayerKind::Image {
        src,
        fit: legacy,
        x: c,
    } = &d.layer.kind
    else {
        return false;
    };
    let c: &Config = c;
    let fit_now = fit(c, *legacy);
    // A live input: its latest picture, nothing until it has one.
    let live = if c.input.trim().is_empty() {
        None
    } else {
        match d.rd.live_picture(c.input.trim()) {
            Some(p) => Some(p),
            None => return true,
        }
    };
    // A Video with nothing chosen yet shows nothing on air.
    if c.video && live.is_none() && c.frames.is_empty() && src.trim().is_empty() {
        return true;
    }
    // The source: a frame of the sequence, or the picture.
    let wanted = if c.frames.is_empty() {
        d.r.image_src
            .clone()
            .unwrap_or_else(|| interpolate_text(src, d.data))
    } else {
        let s = seq(c, st, d.time.now_ms, d.time.age_secs);
        interpolate_text(&c.frames[s.idx.min(c.frames.len() - 1)], d.data)
    };
    reload(d, st, wanted.trim());
    let (w, h) = (d.w, d.h);
    let (f, radius) = frame_rect(c, w, h);
    let Some(frame_path) = rrect(f[0], f[1], f[2], f[3], radius) else {
        return true;
    };
    let Some(fmask) = path_mask(d, &frame_path) else {
        return true;
    };
    // Missing: the fallback picture (cover, no crop or colour), else the slate.
    let mut missing = false;
    let mut source = wanted.trim().to_string();
    if live.is_none() && (source.is_empty() || d.image_size(&source).is_none()) {
        missing = true;
        source = interpolate_text(&c.fallback, d.data).trim().to_string();
        if source.is_empty() || d.image_size(&source).is_none() {
            slate(d, f, &fmask);
            stroke(d, &frame_path, &fmask);
            return true;
        }
    }
    let (fit_now, cr, mode) = if missing {
        (Fit::Cover, Crop::default(), Colorize::None)
    } else {
        (fit_now, crop(c), c.colorize)
    };
    let tint = Draw::hex(&c.tint);
    let key = format!("{source}|{mode:?}|{}", c.tint);
    let opacity = d.opacity;
    let tf = d.tf;
    let mut cache = TINTED.lock().unwrap_or_else(|e| e.into_inner());
    let img: &Pixmap = if let Some(p) = &live {
        p
    } else if let Some(i) = d.rd.image(&source) {
        i
    } else {
        return true;
    };
    let img: &Pixmap = if mode == Colorize::None || live.is_some() {
        img
    } else {
        let map = cache.get_or_insert_with(HashMap::new);
        if !map.contains_key(&key) {
            if map.len() > 24 {
                map.clear();
            }
            map.insert(key.clone(), colorized(img, mode, tint));
        }
        &map[&key]
    };
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    if fit_now == Fit::Tile {
        let k = c.tile_scale.clamp(1.0, 1000.0) / 100.0;
        let paint = Paint {
            shader: tiny_skia::Pattern::new(
                img.as_ref(),
                SpreadMode::Repeat,
                tiny_skia::FilterQuality::Bicubic,
                opacity,
                Transform::from_translate(f[0], f[1]).pre_scale(k, k),
            ),
            anti_alias: true,
            ..Default::default()
        };
        d.pm.fill_path(&frame_path, &paint, FillRule::Winding, tf, Some(&fmask));
    } else {
        let (win, pic) = place(c, (iw, ih), (f[2], f[3]), fit_now, cr);
        let mut m = fmask.clone();
        if let Some(r) = Rect::from_xywh(
            f[0] + win[0],
            f[1] + win[1],
            win[2].max(0.01),
            win[3].max(0.01),
        ) {
            m.intersect_path(&PathBuilder::from_rect(r), FillRule::Winding, true, tf);
        }
        let img_tf = tf.pre_concat(
            Transform::from_translate(f[0] + pic[0], f[1] + pic[1])
                .pre_scale(pic[2] / iw.max(1.0), pic[3] / ih.max(1.0)),
        );
        let paint = PixmapPaint {
            opacity,
            quality: tiny_skia::FilterQuality::Bicubic,
            ..Default::default()
        };
        d.pm.draw_pixmap(0, 0, img.as_ref(), &paint, img_tf, Some(&m));
    }
    drop(cache);
    stroke(d, &frame_path, &fmask);
    true
}

/// The stroke inside the frame (`stroke`, `strokeWidth`).
fn stroke(d: &mut Draw, path: &tiny_skia::Path, mask: &Mask) {
    let width = d.num(Prop::StrokeWidth);
    if width <= 0.0 {
        return;
    }
    let paint = paint_for(d.color(Prop::Stroke), d.opacity);
    let st = Stroke {
        width: width * 2.0,
        ..Default::default()
    };
    d.pm.stroke_path(path, &paint, &st, d.tf, Some(mask));
}
