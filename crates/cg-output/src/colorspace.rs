//! RGBA → Y'CbCr conversions for baseband outputs.

/// Narrow-range (video levels) BT.709 conversion of one premultiplied pixel.
/// Returns 10-bit (Y, Cb, Cr). Premultiplied RGB is what a keyer expects for a
/// "shaped" fill, which is the default for 2110 / SDI key+fill pairs.
#[inline]
pub fn rgb_to_ycbcr709_10(r: u8, g: u8, b: u8) -> (u16, u16, u16) {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let cb = (b - y) / 1.8556;
    let cr = (r - y) / 1.5748;
    let y10 = (64.0 + y * 876.0).round().clamp(64.0, 940.0) as u16;
    let cb10 = (512.0 + cb * 896.0).round().clamp(64.0, 960.0) as u16;
    let cr10 = (512.0 + cr * 896.0).round().clamp(64.0, 960.0) as u16;
    (y10, cb10, cr10)
}

/// Key signal: alpha mapped to luma, neutral chroma.
#[inline]
pub fn alpha_to_key10(a: u8) -> (u16, u16, u16) {
    let y = (64.0 + (a as f32 / 255.0) * 876.0).round() as u16;
    (y, 512, 512)
}

// Fixed-point (Q16) BT.709 narrow-range coefficients on 8-bit input,
// pre-scaled to 10-bit output: Y in 64..940, Cb/Cr centred on 512.
const fn q(v: f64) -> i32 {
    (v * 65536.0 + if v >= 0.0 { 0.5 } else { -0.5 }) as i32
}
const YS: f64 = 876.0 / 255.0;
const CS: f64 = 896.0 / 255.0;
const KY: [i32; 3] = [q(0.2126 * YS), q(0.7152 * YS), q(0.0722 * YS)];
const KCB: [i32; 3] = [
    q(-0.2126 / 1.8556 * CS),
    q(-0.7152 / 1.8556 * CS),
    q(0.5 * CS),
];
const KCR: [i32; 3] = [
    q(0.5 * CS),
    q(-0.7152 / 1.5748 * CS),
    q(-0.0722 / 1.5748 * CS),
];

#[inline(always)]
fn dot(k: [i32; 3], r: i32, g: i32, b: i32) -> i32 {
    k[0] * r + k[1] * g + k[2] * b
}

/// Packs one line of RGBA into RFC 4175 YCbCr-4:2:2 10-bit pgroups
/// (5 bytes per 2 pixels: Cb Y0 Cr Y1, big-endian bit stream).
/// Integer-only hot path (see `examples/bench_packetize.rs`).
pub fn pack_line_422_10(rgba: &[u8], out: &mut Vec<u8>, key: bool) {
    out.clear();
    out.reserve(rgba.len() / 8 * 5 + 5);
    const HALF: i32 = 1 << 15;
    for pair in rgba.chunks(8) {
        let p1 = if pair.len() == 8 {
            &pair[4..8]
        } else {
            &pair[0..4]
        };
        let (y0, y1, cb, cr) = if key {
            let k = |a: u8| 64 + ((a as i32 * q(YS) + HALF) >> 16);
            (k(pair[3]), k(p1[3]), 512, 512)
        } else {
            let (r0, g0, b0) = (pair[0] as i32, pair[1] as i32, pair[2] as i32);
            let (r1, g1, b1) = (p1[0] as i32, p1[1] as i32, p1[2] as i32);
            let y0 = 64 + ((dot(KY, r0, g0, b0) + HALF) >> 16);
            let y1 = 64 + ((dot(KY, r1, g1, b1) + HALF) >> 16);
            // Chroma of the averaged pair (co-sited filtering kept simple).
            let (r, g, b) = (r0 + r1, g0 + g1, b0 + b1);
            let cb = 512 + ((dot(KCB, r, g, b) + (1 << 16)) >> 17);
            let cr = 512 + ((dot(KCR, r, g, b) + (1 << 16)) >> 17);
            (y0, y1, cb, cr)
        };
        let c = |v: i32, lo: i32, hi: i32| v.clamp(lo, hi) as u64;
        let bits: u64 = (c(cb, 64, 960) << 30)
            | (c(y0, 64, 940) << 20)
            | (c(cr, 64, 960) << 10)
            | c(y1, 64, 940);
        out.extend_from_slice(&bits.to_be_bytes()[3..8]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels() {
        assert_eq!(rgb_to_ycbcr709_10(0, 0, 0), (64, 512, 512));
        assert_eq!(rgb_to_ycbcr709_10(255, 255, 255), (940, 512, 512));
    }

    #[test]
    fn integer_path_matches_float_reference() {
        let mut out = Vec::new();
        for &(r, g, b) in &[
            (0u8, 0u8, 0u8),
            (255, 255, 255),
            (255, 0, 0),
            (0, 255, 0),
            (0, 0, 255),
            (12, 200, 99),
        ] {
            pack_line_422_10(&[r, g, b, 255, r, g, b, 255], &mut out, false);
            let v = u64::from_be_bytes([0, 0, 0, out[0], out[1], out[2], out[3], out[4]]);
            let (y, cb, cr) = rgb_to_ycbcr709_10(r, g, b);
            for (got, want) in [
                ((v >> 20) & 0x3ff, y),
                ((v >> 30) & 0x3ff, cb),
                ((v >> 10) & 0x3ff, cr),
            ] {
                assert!(
                    (got as i32 - want as i32).abs() <= 1,
                    "{r},{g},{b}: {got} vs {want}"
                );
            }
        }
    }

    #[test]
    fn pgroup_layout() {
        let mut out = Vec::new();
        pack_line_422_10(&[255; 8], &mut out, false);
        assert_eq!(out.len(), 5);
        // Cb=512 Y=940 Cr=512 Y=940
        let v = u64::from_be_bytes([0, 0, 0, out[0], out[1], out[2], out[3], out[4]]);
        assert_eq!((v >> 30) & 0x3ff, 512);
        assert_eq!((v >> 20) & 0x3ff, 940);
        assert_eq!((v >> 10) & 0x3ff, 512);
        assert_eq!(v & 0x3ff, 940);
    }
}
