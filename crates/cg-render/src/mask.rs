//! Clip masks built in the region they cover.
//!
//! A clip (a crop, a group's box, a widget's box) is a frame-sized `Mask`.
//! Intersected with the clip of the parents, tiny-skia fills the path into
//! a second frame-sized mask and multiplies both over the whole frame; a
//! ticker's faded zone is drawn into a frame-sized picture, cut by the parent
//! clip over the whole frame, then read back. Here the same arithmetic is done
//! only where the path can cover (its bounds, plus a margin): elsewhere the
//! result is 0 either way. The coverage is drawn by tiny-skia itself, into a
//! frame-sized buffer kept per thread, so the values are the same, bit for bit.

use std::cell::RefCell;

use tiny_skia::{FillRule, Mask, Paint, Path, Pixmap, Rect, Transform};

thread_local! {
    /// Frame-sized coverage buffers, zero outside of a call.
    static COVER: RefCell<Option<Mask>> = const { RefCell::new(None) };
    static PICTURE: RefCell<Option<Pixmap>> = const { RefCell::new(None) };
}

/// Pixels `path` (through `tf`) may cover in a `w` × `h` frame: its bounds
/// rounded out with a margin (x0, y0, x1, y1).
fn reach(path: &Path, tf: Transform, w: u32, h: u32) -> Option<(usize, usize, usize, usize)> {
    let b = path.clone().transform(tf)?.bounds();
    let clamp = |v: f32, max: u32| (v.max(0.0) as usize).min(max as usize);
    let (x0, y0) = (
        clamp((b.left() - 2.0).floor(), w),
        clamp((b.top() - 2.0).floor(), h),
    );
    let (x1, y1) = (
        clamp((b.right() + 2.0).ceil(), w),
        clamp((b.bottom() + 2.0).ceil(), h),
    );
    Some((x0, y0, x1.max(x0), y1.max(y0)))
}

/// `premultiply_u8` of tiny-skia (how `Mask::intersect_path` multiplies).
#[inline]
fn mul(c: u8, a: u8) -> u8 {
    let prod = u32::from(c) * u32::from(a) + 128;
    ((prod + (prod >> 8)) >> 8) as u8
}

/// `parent` intersected with `path`: what `parent.clone()` then
/// `intersect_path(path, Winding, anti-aliased, tf)` gives.
pub(crate) fn intersect(parent: &Mask, path: &Path, tf: Transform) -> Mask {
    let (w, h) = (parent.width(), parent.height());
    let Some((x0, y0, x1, y1)) = reach(path, tf, w, h) else {
        let mut m = parent.clone();
        m.intersect_path(path, FillRule::Winding, true, tf);
        return m;
    };
    COVER.with(|cell| {
        let mut cell = cell.borrow_mut();
        let cover = match cell.as_mut() {
            Some(c) if (c.width(), c.height()) == (w, h) => c,
            _ => cell.insert(Mask::new(w, h).expect("valid size")),
        };
        cover.fill_path(path, FillRule::Winding, true, tf);
        let mut out = Mask::new(w, h).expect("valid size");
        let (stride, src) = (w as usize, parent.data());
        let (dst, cov) = (out.data_mut(), cover.data_mut());
        for y in y0..y1 {
            let row = y * stride;
            for i in row + x0..row + x1 {
                dst[i] = mul(src[i], cov[i]);
                cov[i] = 0;
            }
        }
        debug_assert!(
            cover.data().iter().all(|v| *v == 0),
            "a path covered pixels outside of its bounds"
        );
        out
    })
}

/// The alpha of `rect` filled with `paint` (through `tf`) in a frame-sized
/// picture, cut by `parent`: what drawing it into a cleared `Pixmap`, then
/// `apply_mask(parent)` and `Mask::from_pixmap(…, Alpha)` give.
pub(crate) fn painted(
    w: u32,
    h: u32,
    rect: Rect,
    paint: &Paint,
    tf: Transform,
    parent: Option<&Mask>,
) -> Option<Mask> {
    let path = tiny_skia::PathBuilder::from_rect(rect);
    let Some((x0, y0, x1, y1)) = reach(&path, tf, w, h) else {
        let mut pm = Pixmap::new(w, h)?;
        pm.fill_rect(rect, paint, tf, None);
        if let Some(m) = parent {
            pm.apply_mask(m);
        }
        return Some(Mask::from_pixmap(pm.as_ref(), tiny_skia::MaskType::Alpha));
    };
    PICTURE.with(|cell| {
        let mut cell = cell.borrow_mut();
        let pm = match cell.as_mut() {
            Some(p) if (p.width(), p.height()) == (w, h) => p,
            _ => cell.insert(Pixmap::new(w, h)?),
        };
        pm.fill_rect(rect, paint, tf, None);
        let mut out = Mask::new(w, h)?;
        let stride = w as usize;
        let (dst, px) = (out.data_mut(), pm.data_mut());
        for y in y0..y1 {
            let row = y * stride;
            for i in row + x0..row + x1 {
                let a = px[i * 4 + 3];
                dst[i] = match parent {
                    // `DestinationIn` of the low precision pipeline: (a × m + 255) / 256.
                    Some(m) => ((u32::from(a) * u32::from(m.data()[i]) + 255) >> 8) as u8,
                    None => a,
                };
                px[i * 4..i * 4 + 4].fill(0);
            }
        }
        debug_assert!(
            pm.data().iter().all(|v| *v == 0),
            "a rectangle was painted outside of its bounds"
        );
        Some(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiny_skia::{GradientStop, LinearGradient, MaskType, PathBuilder, Point, SpreadMode};

    /// Transforms with fractions, scales, rotations, skews.
    fn transforms() -> Vec<Transform> {
        vec![
            Transform::identity(),
            Transform::from_translate(10.3, 7.7),
            Transform::from_translate(3.25, 2.5).pre_scale(0.75, 1.333),
            Transform::from_translate(40.0, -5.0).pre_rotate(17.0),
            Transform::from_row(1.0, 0.1, -0.3, 0.9, 12.6, 3.4),
            Transform::from_translate(-30.0, 20.0).pre_scale(2.5, 2.5),
        ]
    }

    fn rects() -> Vec<Rect> {
        vec![
            Rect::from_xywh(5.0, 6.0, 40.0, 20.0).unwrap(),
            Rect::from_xywh(0.4, 0.6, 13.3, 9.7).unwrap(),
            Rect::from_xywh(-20.0, -10.0, 200.0, 300.0).unwrap(),
            Rect::from_xywh(60.0, 40.0, 0.5, 0.5).unwrap(),
        ]
    }

    fn parent(w: u32, h: u32) -> Mask {
        let mut m = Mask::new(w, h).unwrap();
        let p = PathBuilder::from_circle(50.0, 30.0, 33.3).unwrap();
        m.fill_path(&p, FillRule::Winding, true, Transform::identity());
        m
    }

    #[test]
    fn intersections_are_tiny_skias() {
        let (w, h) = (97, 61);
        let parent = parent(w, h);
        for tf in transforms() {
            for r in rects() {
                let path = PathBuilder::from_rect(r);
                let mut want = parent.clone();
                want.intersect_path(&path, FillRule::Winding, true, tf);
                let got = intersect(&parent, &path, tf);
                assert_eq!(got.data(), want.data(), "{tf:?} {r:?}");
            }
        }
    }

    #[test]
    fn painted_zones_are_tiny_skias() {
        let (w, h) = (97, 61);
        let parent = parent(w, h);
        for tf in transforms() {
            for r in rects() {
                let mut paint = Paint::default();
                paint.set_color_rgba8(0, 0, 0, 255);
                let fade = LinearGradient::new(
                    Point::from_xy(r.x(), r.y()),
                    Point::from_xy(r.right(), r.y()),
                    vec![
                        GradientStop::new(0.0, tiny_skia::Color::from_rgba8(0, 0, 0, 0)),
                        GradientStop::new(0.2, tiny_skia::Color::from_rgba8(0, 0, 0, 255)),
                        GradientStop::new(0.8, tiny_skia::Color::from_rgba8(0, 0, 0, 255)),
                        GradientStop::new(1.0, tiny_skia::Color::from_rgba8(0, 0, 0, 0)),
                    ],
                    SpreadMode::Pad,
                    Transform::identity(),
                );
                for shader in [None, fade] {
                    if let Some(s) = shader {
                        paint.shader = s;
                    }
                    for m in [None, Some(&parent)] {
                        let mut pm = Pixmap::new(w, h).unwrap();
                        pm.fill_rect(r, &paint, tf, None);
                        if let Some(m) = m {
                            pm.apply_mask(m);
                        }
                        let want = Mask::from_pixmap(pm.as_ref(), MaskType::Alpha);
                        let got = painted(w, h, r, &paint, tf, m).unwrap();
                        assert_eq!(got.data(), want.data(), "{tf:?} {r:?}");
                    }
                }
            }
        }
    }
}
