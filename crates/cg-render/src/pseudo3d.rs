//! Pseudo-3D of a layer (`Prop::RotateX`, `RotateY`, `Perspective`, `Depth`),
//! as the HTML5 renderer's CSS: the layer drawn flat, its thickness stacked
//! behind it (`drop-shadow()` copies in its own space), then seen turned
//! round its anchor with a perspective (`perspective() rotateX() rotateY()`).

use tiny_skia::{Mask, Pixmap, Transform};

/// A 3 × 3 matrix, rows first.
pub type M3 = [f32; 9];

fn mul(a: &M3, b: &M3) -> M3 {
    let mut m = [0.0; 9];
    for r in 0..3 {
        for c in 0..3 {
            m[r * 3 + c] = (0..3).map(|k| a[r * 3 + k] * b[k * 3 + c]).sum();
        }
    }
    m
}

fn inverse(m: &M3) -> Option<M3> {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return None;
    }
    let k = 1.0 / det;
    Some([
        (e * i - f * h) * k,
        (c * h - b * i) * k,
        (b * f - c * e) * k,
        (f * g - d * i) * k,
        (a * i - c * g) * k,
        (c * d - a * f) * k,
        (d * h - e * g) * k,
        (b * g - a * h) * k,
        (a * e - b * d) * k,
    ])
}

fn of(t: Transform) -> M3 {
    [t.sx, t.kx, t.tx, t.ky, t.sy, t.ty, 0.0, 0.0, 1.0]
}

/// Where a point of the picture drawn flat is seen once turned: `a` is the
/// layer's space up to its anchor and rotation (the turn happens there),
/// `rx` / `ry` in degrees, `d` the perspective (px).
pub fn homography(a: Transform, rx: f32, ry: f32, d: f32) -> Option<M3> {
    let (sx, cx) = rx.to_radians().sin_cos();
    let (sy, cy) = ry.to_radians().sin_cos();
    let d = d.max(1.0);
    // CSS: perspective(d) rotateX(rx) rotateY(ry) on the point (x, y, 0).
    let p = [cy, 0.0, 0.0, sy * sx, cx, 0.0, sy * cx / d, -sx / d, 1.0];
    let a = of(a);
    Some(mul(&mul(&a, &p), &inverse(&a)?))
}

/// The box of what `pm` shows (alpha > 0), if anything.
pub fn bounds(pm: &Pixmap) -> Option<(i32, i32, i32, i32)> {
    let w = pm.width() as usize;
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for (i, p) in pm.data().as_chunks::<4>().0.iter().enumerate() {
        if p[3] != 0 {
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
    }
    (x0 != usize::MAX).then_some((x0 as i32, y0 as i32, x1 as i32 + 1, y1 as i32 + 1))
}

/// The thickness: the picture's shape stacked `n` times behind it, one step
/// `(vx, vy)` (frame pixels) further each time, in `color` (premultiplied
/// RGBA, opaque).
pub fn extrude(pm: &mut Pixmap, vx: f32, vy: f32, n: u32, color: [u8; 4]) {
    let Some((x0, y0, x1, y1)) = bounds(pm) else {
        return;
    };
    let (w, h) = (pm.width() as i32, pm.height() as i32);
    let mut side = vec![0u8; (w * h) as usize];
    {
        let data = pm.data();
        for t in 1..=n {
            let dx = (vx * t as f32).round() as i32;
            let dy = (vy * t as f32).round() as i32;
            for y in y0.max(-dy)..y1.min(h - dy) {
                let src = (y * w) as usize;
                let dst = ((y + dy) * w) as usize;
                for x in x0.max(-dx)..x1.min(w - dx) {
                    let a = data[(src + x as usize) * 4 + 3];
                    let s = &mut side[dst + (x + dx) as usize];
                    if a > *s {
                        *s = a;
                    }
                }
            }
        }
    }
    // The side under the picture.
    for (p, &s) in pm.data_mut().as_chunks_mut::<4>().0.iter_mut().zip(&side) {
        if s == 0 {
            continue;
        }
        let under = 255 - p[3] as u32;
        for k in 0..4 {
            let c = color[k] as u32 * s as u32 / 255;
            p[k] = (p[k] as u32 + (c * under + 127) / 255).min(255) as u8;
        }
    }
}

/// Lays `src` (its top left at `ox`, `oy` in the frame) on `dst` seen
/// through `h` (frame to frame), at `opacity`, through `mask`.
pub fn warp(
    dst: &mut Pixmap,
    src: &Pixmap,
    ox: i32,
    oy: i32,
    h: &M3,
    opacity: f32,
    mask: Option<&Mask>,
) {
    let Some(hi) = inverse(h) else {
        return;
    };
    let Some((x0, y0, x1, y1)) = bounds(src) else {
        return;
    };
    let (dw, dh) = (dst.width() as i32, dst.height() as i32);
    // Where its corners are seen; one behind the eye: the whole frame is looked at.
    let mut bx = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut behind = false;
    for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
        let (x, y) = ((x + ox) as f32, (y + oy) as f32);
        let w = h[6] * x + h[7] * y + h[8];
        if w <= 1e-3 {
            behind = true;
            continue;
        }
        let px = (h[0] * x + h[1] * y + h[2]) / w;
        let py = (h[3] * x + h[4] * y + h[5]) / w;
        bx = (bx.0.min(px), bx.1.min(py), bx.2.max(px), bx.3.max(py));
    }
    let (fx0, fy0, fx1, fy1) = if behind {
        (0, 0, dw, dh)
    } else {
        (
            (bx.0.floor() as i32 - 1).max(0),
            (bx.1.floor() as i32 - 1).max(0),
            (bx.2.ceil() as i32 + 1).min(dw),
            (bx.3.ceil() as i32 + 1).min(dh),
        )
    };
    let (sw, sh) = (src.width() as i32, src.height() as i32);
    let s = src.data();
    let m = mask.map(|m| m.data());
    let op = (opacity.clamp(0.0, 1.0) * 256.0) as u32;
    let d = dst.data_mut();
    for y in fy0..fy1 {
        let py = y as f32 + 0.5;
        for x in fx0..fx1 {
            let px = x as f32 + 0.5;
            let qw = hi[6] * px + hi[7] * py + hi[8];
            if qw.abs() < 1e-6 {
                continue;
            }
            let sx = (hi[0] * px + hi[1] * py + hi[2]) / qw;
            let sy = (hi[3] * px + hi[4] * py + hi[5]) / qw;
            // Seen from the front of the eye only.
            if h[6] * sx + h[7] * sy + h[8] <= 1e-3 {
                continue;
            }
            let (u, v) = (sx - ox as f32 - 0.5, sy - oy as f32 - 0.5);
            let (iu, iv) = (u.floor() as i32, v.floor() as i32);
            if iu < -1 || iv < -1 || iu >= sw || iv >= sh {
                continue;
            }
            let (fu, fv) = (u - iu as f32, v - iv as f32);
            let mut c = [0f32; 4];
            for (dx, dy, k) in [
                (0, 0, (1.0 - fu) * (1.0 - fv)),
                (1, 0, fu * (1.0 - fv)),
                (0, 1, (1.0 - fu) * fv),
                (1, 1, fu * fv),
            ] {
                let (xx, yy) = (iu + dx, iv + dy);
                if k <= 0.0 || xx < 0 || yy < 0 || xx >= sw || yy >= sh {
                    continue;
                }
                let i = ((yy * sw + xx) * 4) as usize;
                for (ch, cc) in c.iter_mut().enumerate() {
                    *cc += s[i + ch] as f32 * k;
                }
            }
            let i = (y * dw + x) as usize;
            let mut a = op;
            if let Some(m) = m {
                a = a * m[i] as u32 / 255;
            }
            let src_a = (c[3] * a as f32 / 256.0).round() as u32;
            if src_a == 0 {
                continue;
            }
            let under = 255 - src_a.min(255);
            let p = &mut d[i * 4..i * 4 + 4];
            for ch in 0..4 {
                let sc = (c[ch] * a as f32 / 256.0).round() as u32;
                p[ch] = (sc + (p[ch] as u32 * under + 127) / 255).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_turn_is_no_change() {
        let a = Transform::from_translate(300.0, 200.0).pre_rotate(30.0);
        let h = homography(a, 0.0, 0.0, 1200.0).unwrap();
        for (x, y) in [(0.0, 0.0), (500.0, 120.0), (-40.0, 900.0)] {
            let w = h[6] * x + h[7] * y + h[8];
            let px = (h[0] * x + h[1] * y + h[2]) / w;
            let py = (h[3] * x + h[4] * y + h[5]) / w;
            assert!((px - x).abs() < 1e-3 && (py - y).abs() < 1e-3);
        }
    }

    #[test]
    fn turned_round_y_the_near_side_grows() {
        // Turned round Y by a positive angle: CSS brings the left side nearer (bigger).
        let a = Transform::from_translate(500.0, 500.0);
        let h = homography(a, 0.0, 40.0, 800.0).unwrap();
        let see = |x: f32, y: f32| {
            let w = h[6] * x + h[7] * y + h[8];
            (
                (h[0] * x + h[1] * y + h[2]) / w,
                (h[3] * x + h[4] * y + h[5]) / w,
            )
        };
        let left = see(300.0, 400.0).1 - see(300.0, 600.0).1;
        let right = see(700.0, 400.0).1 - see(700.0, 600.0).1;
        assert!(left.abs() > right.abs());
        // The anchor stays where it is.
        let c = see(500.0, 500.0);
        assert!((c.0 - 500.0).abs() < 1e-3 && (c.1 - 500.0).abs() < 1e-3);
    }

    #[test]
    fn the_thickness_is_behind_the_picture() {
        let mut pm = Pixmap::new(40, 40).unwrap();
        for y in 10..20 {
            for x in 10..20 {
                let i = (y * 40 + x) * 4;
                pm.data_mut()[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        extrude(&mut pm, 1.0, 1.0, 5, [10, 20, 30, 255]);
        let at = |x: usize, y: usize| pm.data()[(y * 40 + x) * 4..(y * 40 + x) * 4 + 4].to_vec();
        assert_eq!(at(12, 12), vec![255, 255, 255, 255]);
        assert_eq!(at(24, 24), vec![10, 20, 30, 255]);
        assert_eq!(at(26, 26), vec![0, 0, 0, 0]);
    }
}
