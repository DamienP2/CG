//! QR code: drawing (same picture as `web/src/widgets/qrcode.tsx`). The
//! matrix comes from the `qrcode` crate at the chosen correction level; the
//! web gets the very same matrix from `GET /api/qr?data=…&ec=L|M|Q|H`.

use cg_core::wid::qrcode::{
    geo, logo_rect, logo_size, payload, structure, Ecl, FinderStyle, ModStyle, State,
};
use cg_core::{LayerKind, Prop, TextAlign, VerticalAlign};
use tiny_skia::{FillRule, PathBuilder, Rect, Transform};

use super::{rrect, Draw};

/// QR modules of `content` at level `ec` (row-major, true = dark) and the
/// side: the one encoder of the app (`/api/qr` must use it with `ec`).
pub fn qr_modules_ec(content: &str, ec: Ecl) -> Option<(usize, Vec<bool>)> {
    let level = match ec {
        Ecl::L => qrcode::EcLevel::L,
        Ecl::M => qrcode::EcLevel::M,
        Ecl::Q => qrcode::EcLevel::Q,
        Ecl::H => qrcode::EcLevel::H,
    };
    let code = qrcode::QrCode::with_error_correction_level(content.as_bytes(), level).ok()?;
    Some((
        code.width(),
        code.to_colors()
            .into_iter()
            .map(|c| c == qrcode::Color::Dark)
            .collect(),
    ))
}

/// A square of the finder with rounded corners (radius r), as path parts.
fn sq(pb: &mut PathBuilder, x: f32, y: f32, s: f32, r: f32, ccw: bool) {
    let r = r.min(s / 2.0).max(0.0);
    let k = 0.5523 * r;
    if !ccw {
        pb.move_to(x + r, y);
        pb.line_to(x + s - r, y);
        pb.cubic_to(x + s - r + k, y, x + s, y + r - k, x + s, y + r);
        pb.line_to(x + s, y + s - r);
        pb.cubic_to(x + s, y + s - r + k, x + s - r + k, y + s, x + s - r, y + s);
        pb.line_to(x + r, y + s);
        pb.cubic_to(x + r - k, y + s, x, y + s - r + k, x, y + s - r);
        pb.line_to(x, y + r);
        pb.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
    } else {
        pb.move_to(x + r, y);
        pb.cubic_to(x + r - k, y, x, y + r - k, x, y + r);
        pb.line_to(x, y + s - r);
        pb.cubic_to(x, y + s - r + k, x + r - k, y + s, x + r, y + s);
        pb.line_to(x + s - r, y + s);
        pb.cubic_to(x + s - r + k, y + s, x + s, y + s - r + k, x + s, y + s - r);
        pb.line_to(x + s, y + r);
        pb.cubic_to(x + s, y + r - k, x + s - r + k, y, x + s - r, y);
        pb.line_to(x + r, y);
    }
    pb.close();
}

fn circle(pb: &mut PathBuilder, cx: f32, cy: f32, r: f32, ccw: bool) {
    let k = 0.5523 * r;
    pb.move_to(cx, cy - r);
    if !ccw {
        pb.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
        pb.cubic_to(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
        pb.cubic_to(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
        pb.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
    } else {
        pb.cubic_to(cx - k, cy - r, cx - r, cy - k, cx - r, cy);
        pb.cubic_to(cx - r, cy + k, cx - k, cy + r, cx, cy + r);
        pb.cubic_to(cx + k, cy + r, cx + r, cy + k, cx + r, cy);
        pb.cubic_to(cx + r, cy - k, cx + k, cy - r, cx, cy - r);
    }
    pb.close();
}

pub(crate) fn draw(d: &mut Draw, _st: &State) -> bool {
    let LayerKind::QrCode {
        data,
        background,
        x: c,
    } = &d.layer.kind
    else {
        return false;
    };
    let text = payload(c, data, d.data);
    if text.is_empty() {
        return true;
    }
    let Some((n, mods)) = qr_modules_ec(&text, c.ecl) else {
        return true;
    };
    let label = cg_core::anim::interpolate_text(&c.label.text, d.data);
    let g = geo(c, &label, n, d.w, d.h);
    let m = g.m;
    let fill = d.color(Prop::Fill);
    if !c.transparent {
        if let Some(p) = rrect(g.x0, g.y0, g.px, g.px, c.radius) {
            d.fill(&p, Draw::hex(background), FillRule::Winding, None);
        }
    }
    let st = structure(n, c.ecl);
    let (pct, _) = logo_size(c, st.as_ref());
    let rect = logo_rect(n, pct);
    let (ox, oy) = (g.x0 + c.quiet as f32 * m, g.y0 + c.quiet as f32 * m);
    let in_finder =
        |x: usize, y: usize| (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    let hidden = |x: usize, y: usize| {
        rect.is_some_and(|(rx, ry, rn, _)| x >= rx && x < rx + rn && y >= ry && y < ry + rn)
    };
    let dark = |x: i32, y: i32| {
        x >= 0
            && y >= 0
            && (x as usize) < n
            && (y as usize) < n
            && mods[y as usize * n + x as usize]
            && !hidden(x as usize, y as usize)
    };
    let mut pb = PathBuilder::new();
    for y in 0..n {
        for x in 0..n {
            if !dark(x as i32, y as i32) || in_finder(x, y) {
                continue;
            }
            let (px, py) = (ox + x as f32 * m, oy + y as f32 * m);
            match c.mod_style {
                ModStyle::Square => {
                    if let Some(r) = Rect::from_xywh(px, py, m, m) {
                        pb.push_rect(r);
                    }
                }
                ModStyle::Dots => circle(&mut pb, px + m / 2.0, py + m / 2.0, m * 0.45, false),
                ModStyle::Rounded => {
                    let (xi, yi) = (x as i32, y as i32);
                    let r = m / 2.0;
                    let (up, dn, lf, rt) = (
                        dark(xi, yi - 1),
                        dark(xi, yi + 1),
                        dark(xi - 1, yi),
                        dark(xi + 1, yi),
                    );
                    let tl = if !up && !lf { r } else { 0.0 };
                    let tr = if !up && !rt { r } else { 0.0 };
                    let br = if !dn && !rt { r } else { 0.0 };
                    let bl = if !dn && !lf { r } else { 0.0 };
                    let k = 0.5523;
                    pb.move_to(px + tl, py);
                    pb.line_to(px + m - tr, py);
                    if tr > 0.0 {
                        pb.cubic_to(
                            px + m - tr + tr * k,
                            py,
                            px + m,
                            py + tr - tr * k,
                            px + m,
                            py + tr,
                        );
                    }
                    pb.line_to(px + m, py + m - br);
                    if br > 0.0 {
                        pb.cubic_to(
                            px + m,
                            py + m - br + br * k,
                            px + m - br + br * k,
                            py + m,
                            px + m - br,
                            py + m,
                        );
                    }
                    pb.line_to(px + bl, py + m);
                    if bl > 0.0 {
                        pb.cubic_to(
                            px + bl - bl * k,
                            py + m,
                            px,
                            py + m - bl + bl * k,
                            px,
                            py + m - bl,
                        );
                    }
                    pb.line_to(px, py + tl);
                    if tl > 0.0 {
                        pb.cubic_to(px, py + tl - tl * k, px + tl - tl * k, py, px + tl, py);
                    }
                    pb.close();
                }
            }
        }
    }
    if let Some(p) = pb.finish() {
        d.fill(&p, fill, FillRule::Winding, None);
    }
    // Finders.
    let fcol = if c.finder_same {
        fill
    } else {
        Draw::hex(&c.finder_color)
    };
    let mut pb = PathBuilder::new();
    for (fx, fy) in [(0usize, 0usize), (n - 7, 0), (0, n - 7)] {
        let (x, y) = (ox + fx as f32 * m, oy + fy as f32 * m);
        match c.finder_style {
            FinderStyle::Circle => {
                circle(&mut pb, x + 3.5 * m, y + 3.5 * m, 3.5 * m, false);
                circle(&mut pb, x + 3.5 * m, y + 3.5 * m, 2.5 * m, true);
                circle(&mut pb, x + 3.5 * m, y + 3.5 * m, 1.5 * m, false);
            }
            s => {
                let (r1, r2, r3) = if s == FinderStyle::Rounded {
                    (2.2 * m, 1.2 * m, 0.9 * m)
                } else {
                    (0.0, 0.0, 0.0)
                };
                sq(&mut pb, x, y, 7.0 * m, r1, false);
                sq(&mut pb, x + m, y + m, 5.0 * m, r2, true);
                sq(&mut pb, x + 2.0 * m, y + 2.0 * m, 3.0 * m, r3, false);
            }
        }
    }
    if let Some(p) = pb.finish() {
        d.fill(&p, fcol, FillRule::Winding, None);
    }
    // Logo.
    if let Some((rx, _, rn, side)) = rect {
        let lw = (side as f32 * m + 0.5).floor();
        let cx = ox + (rx as f32 + rn as f32 / 2.0) * m;
        let lx = (cx - lw / 2.0 + 0.5).floor();
        let ly = (oy + (rx as f32 + rn as f32 / 2.0) * m - lw / 2.0 + 0.5).floor();
        let src = c.logo.src.trim();
        let drawn = !src.is_empty()
            && d.image_size(src).is_some_and(|(iw, ih)| {
                let s = (lw / iw as f32).min(lw / ih as f32);
                let tf = Transform::from_scale(s, s).post_translate(
                    lx + (lw - iw as f32 * s) / 2.0,
                    ly + (lw - ih as f32 * s) / 2.0,
                );
                d.image(src, tf, 1.0, None).is_some()
            });
        if !drawn {
            if let Some(p) = rrect(lx, ly, lw, lw, lw * 0.22) {
                d.fill(&p, Draw::hex(&c.logo.color), FillRule::Winding, None);
            }
            let (cx, cy) = (lx + lw / 2.0, ly + lw / 2.0);
            let mut pb = PathBuilder::new();
            pb.move_to(cx - lw * 0.16, cy - lw * 0.24);
            pb.line_to(cx + lw * 0.26, cy);
            pb.line_to(cx - lw * 0.16, cy + lw * 0.24);
            pb.close();
            if let Some(p) = pb.finish() {
                let bg = if c.transparent {
                    cg_core::Color::WHITE
                } else {
                    Draw::hex(background)
                };
                d.fill(&p, bg, FillRule::Winding, None);
            }
        }
    }
    // Label pill.
    if g.lab > 0.0 {
        let up = label.to_uppercase();
        let lw =
            d.w.min((g.px * 0.7).max(up.chars().count() as f32 * c.label.size * 0.68 + 60.0));
        let lx = ((d.w - lw) / 2.0 + 0.5).floor();
        if let Some(p) = rrect(lx, g.lab_y, lw.round(), g.lab, g.lab / 2.0) {
            d.fill(&p, Draw::hex(&c.label.bg), FillRule::Winding, None);
        }
        d.text(
            "Inter",
            900,
            c.label.size,
            &up,
            Draw::hex(&c.label.color),
            TextAlign::Center,
            VerticalAlign::Middle,
            (0.0, g.lab_y, d.w, g.lab),
            None,
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads a matrix back with the structure of `cg_core::wid::qrcode`
    /// (format bits, unmasking, RS check of every block): the same
    /// self-check the Designer runs on the web.
    fn self_check(n: usize, m: &[bool], ec: Ecl) -> Result<(), String> {
        let rd = |x: usize, y: usize| m[y * n + x] as u32;
        let mut fb = 0u32;
        for i in 0..=5 {
            fb |= rd(8, i) << i;
        }
        fb |= rd(8, 7) << 6 | rd(8, 8) << 7 | rd(7, 8) << 8;
        for i in 9..15 {
            fb |= rd(14 - i, 8) << i;
        }
        fb ^= 0x5412;
        let mask = (fb >> 10) & 7;
        if fb >> 13 != ec.bits() {
            return Err("level".into());
        }
        let s = structure(n, ec).ok_or("size")?;
        let total = s.block_of.len();
        let mut read = vec![0u8; total];
        let mut bitpos = vec![0usize; total];
        // Bits in placement order: walk the same zigzag.
        let mut right = n as i32 - 1;
        while right >= 1 {
            if right == 6 {
                right = 5;
            }
            for vert in 0..n {
                for j in 0..2 {
                    let x = (right - j) as usize;
                    let up = ((right + 1) & 2) == 0;
                    let y = if up { n - 1 - vert } else { vert };
                    let k = s.cw[y * n + x];
                    if k < 0 {
                        continue;
                    }
                    let k = k as usize;
                    let (xi, yi) = (x as u32, y as u32);
                    let inv = match mask {
                        0 => (xi + yi) % 2 == 0,
                        1 => yi % 2 == 0,
                        2 => xi % 3 == 0,
                        3 => (xi + yi) % 3 == 0,
                        4 => (xi / 3 + yi / 2) % 2 == 0,
                        5 => (xi * yi) % 2 + (xi * yi) % 3 == 0,
                        6 => ((xi * yi) % 2 + (xi * yi) % 3) % 2 == 0,
                        _ => ((xi + yi) % 2 + (xi * yi) % 3) % 2 == 0,
                    };
                    let bit = m[y * n + x] != inv;
                    if bit {
                        read[k] |= 1 << (7 - bitpos[k]);
                    }
                    bitpos[k] += 1;
                }
            }
            right -= 2;
        }
        let mul = |x: u8, y: u8| {
            let mut z: u32 = 0;
            for i in (0..8).rev() {
                z = (z << 1) ^ ((z >> 7) * 0x11d);
                z ^= ((y as u32 >> i) & 1) * x as u32;
            }
            z as u8
        };
        let deg = s.ecc_len;
        let mut div = vec![0u8; deg];
        div[deg - 1] = 1;
        let mut root = 1u8;
        for _ in 0..deg {
            for j in 0..deg {
                div[j] = mul(div[j], root);
                if j + 1 < deg {
                    div[j] ^= div[j + 1];
                }
            }
            root = mul(root, 2);
        }
        let mut blocks: Vec<Vec<u8>> = vec![Vec::new(); s.blocks];
        for (i, b) in read.iter().enumerate() {
            blocks[s.block_of[i]].push(*b);
        }
        for b in blocks {
            let (dat, ecc) = b.split_at(b.len() - deg);
            let mut r = vec![0u8; deg];
            for &x in dat {
                let f = x ^ r.remove(0);
                r.push(0);
                for (i, c) in div.iter().enumerate() {
                    r[i] ^= mul(*c, f);
                }
            }
            if r != ecc {
                return Err("RS".into());
            }
        }
        Ok(())
    }

    #[test]
    fn crate_matrix_reads_back() {
        for text in [
            "https://vote.pulse.tv/final",
            "HELLO 123",
            &"Pulse CG live vote. ".repeat(12),
        ] {
            for ec in [Ecl::L, Ecl::M, Ecl::Q, Ecl::H] {
                let (n, m) = qr_modules_ec(text, ec).unwrap();
                self_check(n, &m, ec).unwrap_or_else(|e| panic!("{ec:?} {n}: {e}"));
            }
        }
    }
}
