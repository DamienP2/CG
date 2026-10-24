//! Pictures kept scaled to the size they are drawn at, and the integer
//! compositing of kept pictures.
//!
//! A picture is drawn through its transform once, into a picture the size
//! of the part of the frame it can cover ([`Scaled::draw`]); that one is then
//! laid on the frame pixel for pixel ([`composite`]), at the layer's
//! opacity, through its clip. Next frames lay the same scaled picture again
//! while the picture, its size on the frame and its sub-pixel position do not
//! change: no filtering per frame (a bicubic upscale of a small logo to a
//! large box costs tens of ms per frame).
//!
//! The picture is drawn this way whether it is kept or not, so a frame is
//! the same, pixel for pixel, whatever was drawn before it (the frames kept
//! by `cache` are the frames drawn whole).

use std::collections::HashMap;

use tiny_skia::{FilterQuality, IntRect, Mask, Pixmap, PixmapPaint, Rect, Transform};

/// Frames a scaled picture is kept unused.
const KEEP_FRAMES: u64 = 250;
/// Bytes of scaled pictures kept at most (the oldest are dropped first).
const MAX_BYTES: usize = 192 << 20;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    /// The picture (source, colouring).
    src: String,
    quality: u8,
    /// Size of the scaled picture.
    size: (u32, u32),
    /// Picture → scaled picture (bits of the f32 terms).
    tf: [u32; 6],
}

struct Entry {
    pm: Pixmap,
    used: u64,
}

/// The scaled pictures of a renderer.
#[derive(Default)]
pub(crate) struct Scaled {
    map: HashMap<Key, Entry>,
    bytes: usize,
    tick: u64,
    /// Scaled pictures drawn and found (tests, measures).
    pub made: u64,
    pub found: u64,
}

fn quality_id(q: FilterQuality) -> u8 {
    match q {
        FilterQuality::Nearest => 0,
        FilterQuality::Bilinear => 1,
        FilterQuality::Bicubic => 2,
    }
}

/// Pixels of the `w` × `h` frame `rect` (through `tf`) can touch, rounded out.
pub(crate) fn device_bounds(rect: Rect, tf: Transform, w: u32, h: u32) -> Option<IntRect> {
    let b = tiny_skia::PathBuilder::from_rect(rect)
        .transform(tf)?
        .bounds();
    let x0 = b.left().floor().max(0.0);
    let y0 = b.top().floor().max(0.0);
    let x1 = b.right().ceil().min(w as f32);
    let y1 = b.bottom().ceil().min(h as f32);
    if !(x1 > x0 && y1 > y0) {
        return None;
    }
    IntRect::from_ltrb(x0 as i32, y0 as i32, x1 as i32, y1 as i32)
}

impl Scaled {
    /// A frame begins: pictures unused for a while are dropped.
    pub fn frame(&mut self) {
        self.tick += 1;
        let tick = self.tick;
        if self.map.is_empty() {
            return;
        }
        let mut bytes = self.bytes;
        self.map.retain(|_, e| {
            let keep = tick - e.used <= KEEP_FRAMES;
            if !keep {
                bytes -= e.pm.data().len();
            }
            keep
        });
        self.bytes = bytes;
    }

    /// Forgets everything (pictures read again).
    pub fn clear(&mut self) {
        self.map.clear();
        self.bytes = 0;
    }

    /// Forgets the scaled copies of a picture (reloaded).
    pub fn forget(&mut self, src: &str) {
        let mut bytes = self.bytes;
        self.map.retain(|k, e| {
            let keep = !(k.src == src || k.src.starts_with(&format!("{src}|")));
            if !keep {
                bytes -= e.pm.data().len();
            }
            keep
        });
        self.bytes = bytes;
    }

    /// The picture `src` drawn by `make` (on a transparent `size` picture,
    /// through `tf`), given to `with`: kept for the next frames when `keep`
    /// (drawn again when not kept, or for another `tf` or size).
    pub fn with_picture(
        &mut self,
        src: &str,
        tf: Transform,
        size: (u32, u32),
        keep: bool,
        make: impl FnOnce(&mut Pixmap),
        with: impl FnOnce(&Pixmap),
    ) {
        let key = Key {
            src: src.to_string(),
            quality: 255,
            size,
            tf: [tf.sx, tf.ky, tf.kx, tf.sy, tf.tx, tf.ty].map(f32::to_bits),
        };
        let tick = self.tick;
        if let Some(e) = self.map.get_mut(&key) {
            e.used = tick;
            self.found += 1;
            return with(&e.pm);
        }
        let Some(mut pm) = Pixmap::new(size.0, size.1) else {
            return;
        };
        make(&mut pm);
        self.made += 1;
        with(&pm);
        if keep {
            self.insert(key, pm);
        }
    }

    fn insert(&mut self, key: Key, pm: Pixmap) {
        self.bytes += pm.data().len();
        self.map.insert(
            key,
            Entry {
                pm,
                used: self.tick,
            },
        );
        // Over budget: the least recently used go.
        while self.bytes > MAX_BYTES && self.map.len() > 1 {
            let Some(old) = self
                .map
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(e) = self.map.remove(&old) {
                self.bytes -= e.pm.data().len();
            }
        }
    }

    /// Draws `img` (named `src`) through `img_tf` on `pm`, at `opacity`, cut
    /// by `mask`, in the region `clip` (frame pixels) only: scaled once with
    /// `quality` into a picture of that region, then laid on the frame.
    /// `keep`: the scaled picture is kept for the next frames (else it is
    /// only drawn: a picture moving or zooming changes every frame).
    /// False when the transform turns or skews the picture (not handled
    /// here: the caller draws it directly).
    #[allow(clippy::too_many_arguments)]
    pub fn draw(
        &mut self,
        pm: &mut Pixmap,
        src: &str,
        img: &Pixmap,
        img_tf: Transform,
        quality: FilterQuality,
        opacity: f32,
        mask: Option<&Mask>,
        clip: Option<IntRect>,
        keep: bool,
    ) -> bool {
        if img_tf.kx != 0.0 || img_tf.ky != 0.0 || img_tf.sx <= 0.0 || img_tf.sy <= 0.0 {
            return false;
        }
        if opacity <= 0.0 {
            return true;
        }
        let Some(img_rect) = Rect::from_xywh(0.0, 0.0, img.width() as f32, img.height() as f32)
        else {
            return true;
        };
        let Some(mut region) = device_bounds(img_rect, img_tf, pm.width(), pm.height()) else {
            return true;
        };
        if let Some(c) = clip {
            match region.intersect(&c) {
                Some(r) => region = r,
                None => return true,
            }
        }
        let (x0, y0) = (region.x(), region.y());
        let tf = Transform::from_translate(-(x0 as f32), -(y0 as f32)).pre_concat(img_tf);
        let key = Key {
            src: src.to_string(),
            quality: quality_id(quality),
            size: (region.width(), region.height()),
            tf: [tf.sx, tf.ky, tf.kx, tf.sy, tf.tx, tf.ty].map(f32::to_bits),
        };
        let tick = self.tick;
        if let Some(e) = self.map.get_mut(&key) {
            e.used = tick;
            self.found += 1;
            composite(pm, &e.pm, x0, y0, opacity, mask);
            return true;
        }
        let Some(mut scaled) = Pixmap::new(region.width(), region.height()) else {
            return true;
        };
        let paint = PixmapPaint {
            quality,
            ..Default::default()
        };
        scaled.draw_pixmap(0, 0, img.as_ref(), &paint, tf, None);
        self.made += 1;
        composite(pm, &scaled, x0, y0, opacity, mask);
        if keep {
            self.insert(key, scaled);
        }
        true
    }
}

/// Pieces of a picture: (x, y, picture) of its blocks that are not
/// transparent.
pub(crate) type Tiles = Vec<(i32, i32, Pixmap)>;

/// All zeroes (by blocks of 32 bytes: compared as wide words).
fn clear(b: &[u8]) -> bool {
    let (c, rest) = b.as_chunks::<32>();
    c.iter().all(|x| *x == [0u8; 32]) && rest.iter().all(|x| *x == 0)
}

/// Side of the blocks of [`tiles`].
const TILE: usize = 64;

/// The blocks of `pm` that are not all transparent (graphics scattered over
/// the frame: a bug in a corner, a clock in another), each cleared in `pm`
/// once copied. Laid back with [`composite`], they make what `pm` laid
/// whole would (transparent pixels leave the frame as it is).
pub(crate) fn tiles(pm: &mut Pixmap) -> Tiles {
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let mut out = Vec::new();
    for ty in (0..h).step_by(TILE) {
        let th = TILE.min(h - ty);
        for tx in (0..w).step_by(TILE) {
            let tw = TILE.min(w - tx);
            let data = pm.data_mut();
            let used =
                (ty..ty + th).any(|y| !clear(&data[(y * w + tx) * 4..(y * w + tx + tw) * 4]));
            if !used {
                continue;
            }
            let Some(mut t) = Pixmap::new(tw as u32, th as u32) else {
                continue;
            };
            for (r, y) in (ty..ty + th).enumerate() {
                let src = &mut data[(y * w + tx) * 4..(y * w + tx + tw) * 4];
                t.data_mut()[r * tw * 4..(r + 1) * tw * 4].copy_from_slice(src);
                src.fill(0);
            }
            out.push((tx as i32, ty as i32, t));
        }
    }
    out
}

/// a × b / 255, rounded.
#[inline(always)]
pub(crate) fn mul255(a: u32, b: u32) -> u32 {
    let p = a * b + 128;
    (p + (p >> 8)) >> 8
}

/// The premultiplied pixel `src` × `cov` (0..255) laid over `dst` (source over).
#[inline(always)]
pub(crate) fn over(dst: &mut [u8], src: [u32; 4], cov: u32) {
    let sc = src.map(|v| mul255(v, cov));
    let k = 255 - sc[3].min(255);
    for c in 0..4 {
        dst[c] = (sc[c] + mul255(dst[c] as u32, k)).min(255) as u8;
    }
}

/// `src` (premultiplied) laid with its top-left at (`x0`, `y0`) over `pm`
/// (source over), × `opacity`, × `mask` (frame sized). Integer arithmetic,
/// rounded: an opaque pixel fully covered is copied as is, a transparent one
/// leaves the frame as it is.
pub(crate) fn composite(
    pm: &mut Pixmap,
    src: &Pixmap,
    x0: i32,
    y0: i32,
    opacity: f32,
    mask: Option<&Mask>,
) {
    let (fw, fh) = (pm.width() as i32, pm.height() as i32);
    let (sw, sh) = (src.width() as i32, src.height() as i32);
    let (lx, ly) = (x0.max(0), y0.max(0));
    let (rx, ry) = ((x0 + sw).min(fw), (y0 + sh).min(fh));
    if rx <= lx || ry <= ly {
        return;
    }
    let op = (opacity.clamp(0.0, 1.0) * 255.0).round() as u32;
    if op == 0 {
        return;
    }
    let mask = mask.filter(|m| (m.width(), m.height()) == (pm.width(), pm.height()));
    let n = (rx - lx) as usize;
    let sdata = src.data();
    let mdata = mask.map(|m| m.data());
    let dst = pm.data_mut();
    for y in ly..ry {
        let drow = (y * fw + lx) as usize;
        let srow = ((y - y0) * sw + (lx - x0)) as usize;
        let d = &mut dst[drow * 4..(drow + n) * 4];
        let s = &sdata[srow * 4..(srow + n) * 4];
        match (mdata, op) {
            (None, 255) => {
                for (dp, sp) in d
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(s.as_chunks::<4>().0)
                {
                    let sa = sp[3] as u32;
                    if sa == 255 {
                        *dp = *sp;
                    } else if *sp != [0, 0, 0, 0] {
                        let k = 255 - sa;
                        for c in 0..4 {
                            dp[c] = (sp[c] as u32 + mul255(dp[c] as u32, k)).min(255) as u8;
                        }
                    }
                }
            }
            _ => {
                let m = mdata.map(|m| &m[drow..drow + n]);
                let pixels = d
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(s.as_chunks::<4>().0);
                for (i, (dp, sp)) in pixels.enumerate() {
                    let cov = match m {
                        Some(m) if op == 255 => m[i] as u32,
                        Some(m) => mul255(m[i] as u32, op),
                        None => op,
                    };
                    if cov == 0 || *sp == [0, 0, 0, 0] {
                        continue;
                    }
                    if cov == 255 && sp[3] == 255 {
                        *dp = *sp;
                        continue;
                    }
                    over(dp, [0, 1, 2, 3].map(|c| sp[c] as u32), cov);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiny_skia::{FillRule, PathBuilder};

    fn picture(w: u32, h: u32) -> Pixmap {
        let mut p = Pixmap::new(w, h).unwrap();
        for (i, px) in p.data_mut().as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let a = if i % 7 == 0 { 128 } else { 255 } as u32;
            let c = [
                (i * 37 % 256) as u32,
                (i * 11 % 256) as u32,
                (i * 3 % 256) as u32,
            ];
            px[0] = (c[0] * a / 255) as u8;
            px[1] = (c[1] * a / 255) as u8;
            px[2] = (c[2] * a / 255) as u8;
            px[3] = a as u8;
        }
        p
    }

    fn frame() -> Pixmap {
        let mut f = Pixmap::new(120, 90).unwrap();
        f.fill(tiny_skia::Color::from_rgba8(20, 60, 200, 255));
        f
    }

    fn mask() -> Mask {
        let mut m = Mask::new(120, 90).unwrap();
        let p = PathBuilder::from_circle(60.0, 45.0, 38.3).unwrap();
        m.fill_path(&p, FillRule::Winding, true, Transform::identity());
        m
    }

    /// A picture kept scaled draws the same pixels as when drawn fresh.
    #[test]
    fn a_kept_scaled_picture_draws_what_a_fresh_one_does() {
        let img = picture(16, 10);
        let tf = Transform::from_translate(10.3, 7.6).pre_scale(6.1, 6.4);
        let m = mask();
        let mut s = Scaled::default();
        let mut a = frame();
        assert!(s.draw(
            &mut a,
            "p",
            &img,
            tf,
            FilterQuality::Bicubic,
            0.8,
            Some(&m),
            None,
            true
        ));
        assert_eq!((s.made, s.found), (1, 0));
        let mut b = frame();
        s.frame();
        assert!(s.draw(
            &mut b,
            "p",
            &img,
            tf,
            FilterQuality::Bicubic,
            0.8,
            Some(&m),
            None,
            true
        ));
        assert_eq!((s.made, s.found), (1, 1));
        assert_eq!(a.data(), b.data());
        // Not kept: drawn again, the same pixels.
        let mut fresh = Scaled::default();
        let mut c = frame();
        fresh.draw(
            &mut c,
            "p",
            &img,
            tf,
            FilterQuality::Bicubic,
            0.8,
            Some(&m),
            None,
            false,
        );
        assert_eq!(a.data(), c.data());
        assert!(fresh.map.is_empty());
        // Close to tiny-skia's own drawing (±1 where partly covered).
        let mut want = frame();
        let paint = PixmapPaint {
            opacity: 0.8,
            quality: FilterQuality::Bicubic,
            ..Default::default()
        };
        want.draw_pixmap(0, 0, img.as_ref(), &paint, tf, Some(&m));
        let worst = a
            .data()
            .iter()
            .zip(want.data())
            .map(|(x, y)| x.abs_diff(*y))
            .max()
            .unwrap();
        assert!(worst <= 2, "{worst}");
    }

    /// Another size, position or picture: scaled again; reloaded: forgotten.
    #[test]
    fn scaled_pictures_follow_their_picture_and_transform() {
        let img = picture(16, 10);
        let mut s = Scaled::default();
        let tf = Transform::from_translate(10.0, 7.0).pre_scale(3.0, 3.0);
        let mut f = frame();
        s.draw(
            &mut f,
            "p",
            &img,
            tf,
            FilterQuality::Bicubic,
            1.0,
            None,
            None,
            true,
        );
        // Moved by whole pixels: the same scaled picture.
        let moved = Transform::from_translate(12.0, 9.0).pre_scale(3.0, 3.0);
        s.draw(
            &mut f,
            "p",
            &img,
            moved,
            FilterQuality::Bicubic,
            1.0,
            None,
            None,
            true,
        );
        assert_eq!((s.made, s.found), (1, 1));
        // Bigger, or by a fraction of a pixel: another one.
        let bigger = Transform::from_translate(10.0, 7.0).pre_scale(3.5, 3.0);
        s.draw(
            &mut f,
            "p",
            &img,
            bigger,
            FilterQuality::Bicubic,
            1.0,
            None,
            None,
            true,
        );
        let half = Transform::from_translate(10.5, 7.0).pre_scale(3.0, 3.0);
        s.draw(
            &mut f,
            "p",
            &img,
            half,
            FilterQuality::Bicubic,
            1.0,
            None,
            None,
            true,
        );
        s.draw(
            &mut f,
            "q",
            &img,
            tf,
            FilterQuality::Bicubic,
            1.0,
            None,
            None,
            true,
        );
        assert_eq!((s.made, s.found), (4, 1));
        s.forget("p");
        assert_eq!(s.map.len(), 1);
        s.draw(
            &mut f,
            "p",
            &img,
            tf,
            FilterQuality::Bicubic,
            1.0,
            None,
            None,
            true,
        );
        assert_eq!(s.made, 5);
        // Unused for long: dropped.
        for _ in 0..=KEEP_FRAMES + 1 {
            s.frame();
        }
        assert!(s.map.is_empty() && s.bytes == 0);
        // Turned: left to the caller.
        let turned = Transform::from_rotate(10.0);
        assert!(!s.draw(
            &mut f,
            "p",
            &img,
            turned,
            FilterQuality::Bicubic,
            1.0,
            None,
            None,
            true
        ));
    }

    /// Laid at full opacity without a clip: opaque pixels copied, others
    /// blended over.
    #[test]
    fn composite_is_source_over() {
        let src = picture(30, 20);
        let mut f = frame();
        let before = f.clone();
        composite(&mut f, &src, -5, 80, 1.0, None);
        // Only rows 80..90 and columns 0..25 touched.
        for (i, (a, b)) in f.data().chunks(4).zip(before.data().chunks(4)).enumerate() {
            let (x, y) = (i % 120, i / 120);
            if y < 80 || x >= 25 {
                assert_eq!(a, b);
            } else {
                let s = &src.data()[(((y - 80) * 30 + x + 5) * 4)..][..4];
                if s[3] == 255 {
                    assert_eq!(a, s);
                }
            }
        }
    }
}
