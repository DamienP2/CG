//! Drop shadow of a layer (`Layer::drop_shadow`), as the HTML5 renderer's
//! CSS `drop-shadow()` on the layer's box: the alpha of what the layer drew
//! (with its children), blurred (Gaussian, σ = blur / 2), in the shadow's
//! colour, offset, under the layer. Offset and blur are in the layer's space.

use cg_core::Color;
use tiny_skia::{FilterQuality, Pixmap, PixmapPaint, Transform};

/// The box of the pixels of `pm` that are not transparent: (x0, y0, x1, y1), x1 / y1 excluded.
pub fn opaque_box(pm: &Pixmap) -> Option<(i32, i32, i32, i32)> {
    let w = pm.width() as usize;
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for (y, row) in pm.data().chunks_exact(w * 4).enumerate() {
        let mut first = None;
        let mut last = 0;
        for (x, px) in row.as_chunks::<4>().0.iter().enumerate() {
            if px[3] != 0 {
                first.get_or_insert(x);
                last = x;
            }
        }
        if let Some(f) = first {
            x0 = x0.min(f);
            x1 = x1.max(last + 1);
            y0 = y0.min(y);
            y1 = y + 1;
        }
    }
    (x0 != usize::MAX).then_some((x0 as i32, y0 as i32, x1 as i32, y1 as i32))
}

/// Box sizes whose three passes approximate a Gaussian of `sigma`.
fn boxes(sigma: f32) -> [usize; 3] {
    let n = 3.0;
    let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut wl = ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    let m = ((12.0 * sigma * sigma - n * (wl * wl) as f32 - 4.0 * n * wl as f32 - 3.0 * n)
        / (-4.0 * wl as f32 - 4.0))
        .round() as i32;
    std::array::from_fn(|i| {
        if (i as i32) < m {
            wl as usize
        } else {
            wu as usize
        }
    })
}

/// One box pass along rows (`stride` 1) or columns (`stride` = width); outside is 0.
fn box_pass(
    src: &[f32],
    dst: &mut [f32],
    len: usize,
    lines: usize,
    step: usize,
    line_step: usize,
    radius: usize,
) {
    let div = (2 * radius + 1) as f32;
    for l in 0..lines {
        let at = |i: usize| l * line_step + i * step;
        let mut sum = 0.0;
        for i in 0..radius.min(len) {
            sum += src[at(i)];
        }
        for i in 0..len {
            if i + radius < len {
                sum += src[at(i + radius)];
            }
            dst[at(i)] = sum / div;
            if i >= radius {
                sum -= src[at(i - radius)];
            }
        }
    }
}

/// Gaussian blur (three box passes each way) of a `w` × `h` alpha buffer.
fn blur(alpha: &mut [f32], w: usize, h: usize, sigma: f32) {
    if sigma < 0.3 {
        return;
    }
    let mut tmp = vec![0.0; alpha.len()];
    for size in boxes(sigma) {
        let r = (size - 1) / 2;
        box_pass(alpha, &mut tmp, w, h, 1, w, r);
        box_pass(&tmp, alpha, h, w, w, 1, r);
    }
}

/// The layer drawn alone (`content`: frame-sized, premultiplied) over its shadow, offset by
/// (`dx`, `dy`) device pixels and blurred by `sigma` device pixels: the picture of the box both
/// cover (inside the frame) and where it goes. None when the layer drew nothing.
pub fn compose(
    content: &Pixmap,
    color: Color,
    dx: f32,
    dy: f32,
    sigma: f32,
) -> Option<(Pixmap, i32, i32)> {
    let (x0, y0, x1, y1) = opaque_box(content)?;
    let [cr, cg, cb, ca] = color.0.map(|c| c.clamp(0.0, 1.0));
    let pad = (sigma * 3.0).ceil() as i32 + 1;
    let (bx, by) = (x0 - pad, y0 - pad);
    let (bw, bh) = ((x1 - x0 + 2 * pad) as usize, (y1 - y0 + 2 * pad) as usize);
    let (cw, ch) = (content.width() as i32, content.height() as i32);
    // The box of the layer and of its shadow, inside the frame.
    let (ux0, uy0) = (
        x0.min((bx as f32 + dx).floor() as i32).max(0),
        y0.min((by as f32 + dy).floor() as i32).max(0),
    );
    let (ux1, uy1) = (
        x1.max((bx as f32 + dx).ceil() as i32 + bw as i32).min(cw),
        y1.max((by as f32 + dy).ceil() as i32 + bh as i32).min(ch),
    );
    let mut out = Pixmap::new((ux1 - ux0).max(1) as u32, (uy1 - uy0).max(1) as u32)?;
    if ca > 0.0 {
        let mut alpha = vec![0.0f32; bw * bh];
        let data = content.data();
        for (y, row) in alpha.chunks_exact_mut(bw).enumerate() {
            let sy = by + y as i32;
            if sy < 0 || sy >= ch {
                continue;
            }
            for (x, a) in row.iter_mut().enumerate() {
                let sx = bx + x as i32;
                if (0..cw).contains(&sx) {
                    *a = data[((sy * cw + sx) * 4 + 3) as usize] as f32 / 255.0;
                }
            }
        }
        blur(&mut alpha, bw, bh, sigma);
        let mut sh = Pixmap::new(bw as u32, bh as u32)?;
        for (px, a) in sh.data_mut().as_chunks_mut::<4>().0.iter_mut().zip(&alpha) {
            let a = (a * ca).clamp(0.0, 1.0);
            px[0] = (cr * a * 255.0).round() as u8;
            px[1] = (cg * a * 255.0).round() as u8;
            px[2] = (cb * a * 255.0).round() as u8;
            px[3] = (a * 255.0).round() as u8;
        }
        let (fx, fy) = ((bx - ux0) as f32 + dx, (by - uy0) as f32 + dy);
        let paint = PixmapPaint {
            quality: if fx.fract() == 0.0 && fy.fract() == 0.0 {
                FilterQuality::Nearest
            } else {
                FilterQuality::Bilinear
            },
            ..PixmapPaint::default()
        };
        out.draw_pixmap(
            0,
            0,
            sh.as_ref(),
            &paint,
            Transform::from_translate(fx, fy),
            None,
        );
    }
    out.draw_pixmap(
        -ux0,
        -uy0,
        content.as_ref(),
        &PixmapPaint::default(),
        Transform::identity(),
        None,
    );
    Some((out, ux0, uy0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_boxes_make_the_gaussian_variance() {
        for sigma in [2.5f32, 6.0, 20.0] {
            // A box of size n has variance (n² − 1) / 12.
            let v: f32 = boxes(sigma)
                .iter()
                .map(|&n| ((n * n) as f32 - 1.0) / 12.0)
                .sum();
            assert!(
                (v - sigma * sigma).abs() / (sigma * sigma) < 0.2,
                "{sigma}: {v}"
            );
        }
    }

    #[test]
    fn a_blur_keeps_the_amount_of_alpha() {
        let (w, h) = (40, 40);
        let mut a = vec![0.0; w * h];
        for y in 15..25 {
            for x in 15..25 {
                a[y * w + x] = 1.0;
            }
        }
        blur(&mut a, w, h, 3.0);
        let total: f32 = a.iter().sum();
        assert!((total - 100.0).abs() < 1.0, "{total}");
        // Spread out, symmetric.
        assert!(a[20 * w + 20] < 1.0 && a[20 * w + 20] > 0.5);
        assert!((a[20 * w + 12] - a[20 * w + 27]).abs() < 1e-3);
    }
}
