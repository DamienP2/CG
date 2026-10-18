//! Vector text: glyph outlines from `ab_glyph` turned into tiny-skia paths so
//! text stays sharp under any transform (scale, rotation).

use std::collections::HashMap;
use std::path::Path;

use ab_glyph::{Font, FontArc, OutlineCurve, ScaleFont};
use cg_core::{TextAlign, VerticalAlign};
use tiny_skia::{Path as SkPath, PathBuilder};

/// Fonts shipped inside the binary so rendering is identical on Linux,
/// macOS and Windows whatever is installed (Inter, SIL OFL 1.1). The server
/// also serves them to the web app under `/fonts/`.
pub const BUNDLED_FONTS: &[(&str, &[u8])] = &[
    (
        "Inter-Regular.otf",
        include_bytes!("../../../assets/fonts/Inter-Regular.otf"),
    ),
    (
        "Inter-Medium.otf",
        include_bytes!("../../../assets/fonts/Inter-Medium.otf"),
    ),
    (
        "Inter-SemiBold.otf",
        include_bytes!("../../../assets/fonts/Inter-SemiBold.otf"),
    ),
    (
        "Inter-Bold.otf",
        include_bytes!("../../../assets/fonts/Inter-Bold.otf"),
    ),
    (
        "Inter-ExtraBold.otf",
        include_bytes!("../../../assets/fonts/Inter-ExtraBold.otf"),
    ),
];

pub struct FontStore {
    db: fontdb::Database,
    cache: HashMap<fontdb::ID, FontArc>,
    extra_dir: Option<std::path::PathBuf>,
}

/// A font family available to templates.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub family: String,
    pub weights: Vec<u16>,
    /// "bundled", "uploaded" or "system".
    pub source: &'static str,
}

/// Bumped when fonts are added: renderers reload their font database.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn fonts_changed() {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn font_generation() -> u64 {
    GENERATION.load(std::sync::atomic::Ordering::Relaxed)
}

impl FontStore {
    pub fn new(extra_dir: Option<&Path>) -> Self {
        let mut db = fontdb::Database::new();
        for (_, data) in BUNDLED_FONTS {
            db.load_font_data(data.to_vec());
        }
        db.load_system_fonts();
        if let Some(dir) = extra_dir {
            db.load_fonts_dir(dir);
        }
        db.set_sans_serif_family("Inter");
        tracing::info!(faces = db.len(), "font database loaded");
        Self {
            db,
            cache: HashMap::new(),
            extra_dir: extra_dir.map(Path::to_path_buf),
        }
    }

    /// Every family with its weights (regular styles only).
    pub fn families(&self) -> Vec<FontFamily> {
        let mut map: std::collections::BTreeMap<String, FontFamily> =
            std::collections::BTreeMap::new();
        for face in self.db.faces() {
            if face.style != fontdb::Style::Normal {
                continue;
            }
            let Some((name, _)) = face.families.first() else {
                continue;
            };
            let source = match &face.source {
                fontdb::Source::Binary(_) => "bundled",
                fontdb::Source::File(p) | fontdb::Source::SharedFile(p, _)
                    if self.extra_dir.as_ref().is_some_and(|d| p.starts_with(d)) =>
                {
                    "uploaded"
                }
                _ => "system",
            };
            let e = map
                .entry(name.to_lowercase())
                .or_insert_with(|| FontFamily {
                    family: name.clone(),
                    weights: Vec::new(),
                    source,
                });
            if !e.weights.contains(&face.weight.0) {
                e.weights.push(face.weight.0);
            }
        }
        let mut out: Vec<FontFamily> = map.into_values().collect();
        for f in &mut out {
            f.weights.sort_unstable();
        }
        out
    }

    /// The font file used for `family` at `weight` (exact family only), to
    /// serve the same font to browsers.
    pub fn file(&self, family: &str, weight: u16) -> Option<Vec<u8>> {
        let families = [fontdb::Family::Name(family)];
        let id = self.db.query(&fontdb::Query {
            families: &families,
            weight: fontdb::Weight(weight),
            ..Default::default()
        })?;
        self.db
            .with_face_data(id, |data, index| (index == 0).then(|| data.to_vec()))
            .flatten()
    }

    pub fn font(&mut self, family: &str, weight: u16) -> Option<FontArc> {
        let families = [fontdb::Family::Name(family), fontdb::Family::SansSerif];
        let query = fontdb::Query {
            families: &families,
            weight: fontdb::Weight(weight),
            ..Default::default()
        };
        let id = self.db.query(&query)?;
        if let Some(f) = self.cache.get(&id) {
            return Some(f.clone());
        }
        let font = self
            .db
            .with_face_data(id, |data, index| {
                ab_glyph::FontVec::try_from_vec_and_index(data.to_vec(), index).ok()
            })
            .flatten()
            .map(FontArc::new)?;
        self.cache.insert(id, font.clone());
        Some(font)
    }
}

pub struct TextStyle {
    pub size: f32,
    pub letter_spacing: f32,
    pub align: TextAlign,
    pub vertical_align: VerticalAlign,
    pub box_w: f32,
    pub box_h: f32,
    /// In font sizes ([`LINE_HEIGHT`] by default).
    pub line_height: f32,
    pub decoration: cg_core::TextDecoration,
}

/// Line height multiplier — must match the web renderer (`line-height: 1.2`).
pub const LINE_HEIGHT: f32 = 1.2;

/// Width of the widest line, matching [`layout_text`]'s advances.
pub fn text_width(font: &FontArc, text: &str, size: f32, letter_spacing: f32) -> f32 {
    let upem = font.units_per_em().unwrap_or(1000.0);
    let scaled = font.as_scaled(ab_glyph::PxScale::from(
        size * font.height_unscaled() / upem,
    ));
    text.split('\n')
        .map(|line| {
            let glyphs: Vec<_> = line.chars().map(|c| font.glyph_id(c)).collect();
            let mut width = 0.0;
            for (j, g) in glyphs.iter().enumerate() {
                width += scaled.h_advance(*g);
                if j + 1 < glyphs.len() {
                    width += scaled.kern(*g, glyphs[j + 1]) + letter_spacing;
                }
            }
            width
        })
        .fold(0.0, f32::max)
}

/// Breaks the lines of `text` at spaces so that none is wider than
/// `max_w` (a word longer than the box stays on its own line), like the
/// web renderer's `white-space: pre-wrap`.
pub fn wrap_text(font: &FontArc, text: &str, size: f32, letter_spacing: f32, max_w: f32) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let mut cur = String::new();
        for word in line.split(' ') {
            let candidate = if cur.is_empty() {
                word.to_string()
            } else {
                format!("{cur} {word}")
            };
            if !cur.is_empty() && text_width(font, &candidate, size, letter_spacing) > max_w {
                out.push(std::mem::take(&mut cur));
                cur = word.to_string();
            } else {
                cur = candidate;
            }
        }
        out.push(cur);
    }
    out.join("\n")
}

/// A text made to fit its box (see [`fit_text`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Fitted {
    /// The lines to draw (wrapped, or shortened with "…").
    pub text: String,
    pub size: f32,
    /// Horizontal scale (1 = as designed).
    pub squeeze: f32,
    /// Cut at the box when drawn.
    pub clip: bool,
}

/// Height of a block of `lines` lines: the last one without its leading,
/// so that one line of a size fits a box of that height.
fn block_height(lines: usize, size: f32, line_height: f32) -> f32 {
    if lines == 0 {
        0.0
    } else {
        (lines - 1) as f32 * size * line_height + size
    }
}

/// Makes `content` fit the box of `style` the way `overflow` says. `wrap`:
/// a paragraph (lines wrap at the box width). Same rules as the web
/// renderer (`engine/textFit.ts`).
pub fn fit_text(
    font: &FontArc,
    content: &str,
    style: &TextStyle,
    wrap: bool,
    overflow: cg_core::TextOverflow,
    squeeze_min: f32,
    min_size: f32,
) -> Fitted {
    use cg_core::TextOverflow as O;
    let (bw, bh, lh, ls) = (style.box_w.max(1.0), style.box_h.max(1.0), style.line_height, style.letter_spacing);
    let layout = |size: f32, width: f32| -> (String, f32, f32) {
        let t = if wrap { wrap_text(font, content, size, ls, width) } else { content.to_string() };
        let w = text_width(font, &t, size, ls);
        let h = block_height(t.split('\n').count(), size, lh);
        (t, w, h)
    };
    let size0 = style.size;
    let (text, w, h) = layout(size0, bw);
    let eps = 0.5;
    if w <= bw + eps && h <= bh + eps || overflow == O::Visible {
        return Fitted { text, size: size0, squeeze: 1.0, clip: false };
    }
    match overflow {
        O::Visible => unreachable!(),
        O::Clip => Fitted { text, size: size0, squeeze: 1.0, clip: true },
        O::Ellipsis => {
            let max_lines = ((bh - size0) / (size0 * lh)).floor().max(0.0) as usize + 1;
            let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
            let cut = lines.len() > max_lines;
            lines.truncate(max_lines);
            let n = lines.len();
            for (i, line) in lines.iter_mut().enumerate() {
                let last = i + 1 == n;
                if text_width(font, line, size0, ls) <= bw + eps && !(last && cut) {
                    continue;
                }
                let mut chars: Vec<char> = line.chars().collect();
                loop {
                    let t: String = chars.iter().collect::<String>().trim_end().to_string() + "…";
                    if chars.is_empty() || text_width(font, &t, size0, ls) <= bw + eps {
                        *line = t;
                        break;
                    }
                    chars.pop();
                }
            }
            Fitted { text: lines.join("\n"), size: size0, squeeze: 1.0, clip: true }
        }
        O::Fit => {
            // Narrower first (one line of text only: a paragraph wraps).
            let sx = if wrap || w <= bw { 1.0 } else { (bw / w).max(squeeze_min.clamp(0.1, 1.0)) };
            let fits = |size: f32| {
                let (t, w, h) = layout(size, bw / sx);
                (w * sx <= bw + eps && h <= bh + eps, t)
            };
            if let (true, t) = fits(size0) {
                return Fitted { text: t, size: size0, squeeze: sx, clip: false };
            }
            // Then smaller, down to the minimum: the largest size that fits.
            let lo_size = size0 * min_size.clamp(0.1, 1.0);
            let (ok, t) = fits(lo_size);
            if !ok {
                return Fitted { text: t, size: lo_size, squeeze: sx, clip: true };
            }
            let (mut lo, mut hi, mut best) = (lo_size, size0, t);
            for _ in 0..14 {
                let mid = (lo + hi) / 2.0;
                match fits(mid) {
                    (true, t) => {
                        lo = mid;
                        best = t;
                    }
                    (false, _) => hi = mid,
                }
            }
            Fitted { text: best, size: lo, squeeze: sx, clip: false }
        }
    }
}

/// Builds a single path containing all glyphs, in layer-local coordinates.
pub fn layout_text(font: &FontArc, text: &str, style: &TextStyle) -> Option<SkPath> {
    // CSS `font-size` is the em size; ab_glyph's PxScale is ascent-descent.
    let upem = font.units_per_em().unwrap_or(1000.0);
    let px = ab_glyph::PxScale::from(style.size * font.height_unscaled() / upem);
    let scaled = font.as_scaled(px);
    let line_h = style.size * style.line_height;
    let lines: Vec<&str> = text.split('\n').collect();
    let block_h = line_h * lines.len() as f32;
    let top = match style.vertical_align {
        VerticalAlign::Top => 0.0,
        VerticalAlign::Middle => (style.box_h - block_h) / 2.0,
        VerticalAlign::Bottom => style.box_h - block_h,
    };
    // Centre the glyph box inside the line box, as CSS does.
    let half_leading = (line_h - (scaled.ascent() - scaled.descent())) / 2.0;
    // Outline coordinates are in font units.
    let s = style.size / upem;

    let mut pb = PathBuilder::new();
    for (i, line) in lines.iter().enumerate() {
        let glyphs: Vec<_> = line.chars().map(|c| font.glyph_id(c)).collect();
        let mut width = 0.0;
        for (j, g) in glyphs.iter().enumerate() {
            width += scaled.h_advance(*g);
            if j + 1 < glyphs.len() {
                width += scaled.kern(*g, glyphs[j + 1]) + style.letter_spacing;
            }
        }
        let mut x = match style.align {
            TextAlign::Left => 0.0,
            TextAlign::Center => (style.box_w - width) / 2.0,
            TextAlign::Right => style.box_w - width,
        };
        let baseline = top + i as f32 * line_h + half_leading + scaled.ascent();
        // Underline / strike through: a bar under the line or across it.
        let bar = match style.decoration {
            cg_core::TextDecoration::Underline => Some(baseline + style.size * 0.1),
            cg_core::TextDecoration::LineThrough => Some(baseline - style.size * 0.3),
            cg_core::TextDecoration::None => None,
        };
        if let (Some(y), true) = (bar, width > 0.0) {
            let t = (style.size * 0.06).max(1.0);
            if let Some(r) = tiny_skia::Rect::from_xywh(x, y - t / 2.0, width, t) {
                pb.push_rect(r);
            }
        }
        for (j, g) in glyphs.iter().enumerate() {
            if let Some(outline) = font.outline(*g) {
                append_outline(&mut pb, &outline.curves, x, baseline, s);
            }
            x += scaled.h_advance(*g) + style.letter_spacing;
            if j + 1 < glyphs.len() {
                x += scaled.kern(*g, glyphs[j + 1]);
            }
        }
    }
    pb.finish()
}

fn append_outline(pb: &mut PathBuilder, curves: &[OutlineCurve], ox: f32, baseline: f32, s: f32) {
    let tx = |p: ab_glyph::Point| (ox + p.x * s, baseline - p.y * s);
    let mut last: Option<(f32, f32)> = None;
    for c in curves {
        let start = match c {
            OutlineCurve::Line(a, _)
            | OutlineCurve::Quad(a, _, _)
            | OutlineCurve::Cubic(a, _, _, _) => tx(*a),
        };
        let continuous =
            last.is_some_and(|(lx, ly)| (lx - start.0).abs() < 1e-3 && (ly - start.1).abs() < 1e-3);
        if !continuous {
            if last.is_some() {
                pb.close();
            }
            pb.move_to(start.0, start.1);
        }
        let end = match c {
            OutlineCurve::Line(_, b) => {
                let b = tx(*b);
                pb.line_to(b.0, b.1);
                b
            }
            OutlineCurve::Quad(_, c1, b) => {
                let (c1, b) = (tx(*c1), tx(*b));
                pb.quad_to(c1.0, c1.1, b.0, b.1);
                b
            }
            OutlineCurve::Cubic(_, c1, c2, b) => {
                let (c1, c2, b) = (tx(*c1), tx(*c2), tx(*b));
                pb.cubic_to(c1.0, c1.1, c2.0, c2.1, b.0, b.1);
                b
            }
        };
        last = Some(end);
    }
    if last.is_some() {
        pb.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_core::TextOverflow;

    fn style(w: f32, h: f32) -> TextStyle {
        TextStyle {
            size: 50.0,
            letter_spacing: 0.0,
            align: TextAlign::Left,
            vertical_align: VerticalAlign::Middle,
            box_w: w,
            box_h: h,
            line_height: LINE_HEIGHT,
            decoration: cg_core::TextDecoration::None,
        }
    }

    #[test]
    fn fit_ellipsis_clip() {
        let mut store = FontStore::new(None);
        let name = store.families()[0].family.clone();
        let font = store.font(&name, 700).unwrap();
        let text = "Maria Antonietta Gonzalez";
        let w = text_width(&font, text, 50.0, 0.0);
        // Fits: as it is.
        let f = fit_text(&font, text, &style(w + 10.0, 60.0), false, TextOverflow::Fit, 0.8, 0.6);
        assert_eq!((f.size, f.squeeze, f.clip), (50.0, 1.0, false));
        // A little too long: narrower only.
        let f = fit_text(&font, text, &style(w * 0.9, 60.0), false, TextOverflow::Fit, 0.8, 0.6);
        assert_eq!(f.size, 50.0);
        assert!((f.squeeze - 0.9).abs() < 0.01);
        // Much too long: narrower, then smaller.
        let f = fit_text(&font, text, &style(w * 0.6, 60.0), false, TextOverflow::Fit, 0.8, 0.6);
        assert!((f.squeeze - 0.8).abs() < 1e-3 && f.size < 50.0 && f.size >= 30.0 && !f.clip);
        assert!(text_width(&font, &f.text, f.size, 0.0) * f.squeeze <= w * 0.6 + 0.5);
        // Far too long: at the minimums, and cut.
        let f = fit_text(&font, text, &style(w * 0.3, 60.0), false, TextOverflow::Fit, 0.8, 0.6);
        assert!(f.clip && (f.size - 30.0).abs() < 1e-3);
        // "…"
        let f = fit_text(&font, text, &style(w * 0.5, 60.0), false, TextOverflow::Ellipsis, 0.8, 0.6);
        assert!(f.text.ends_with('…') && text_width(&font, &f.text, 50.0, 0.0) <= w * 0.5 + 0.5);
        // A paragraph: wraps, then smaller when the lines are too many.
        let f = fit_text(&font, "one two three four five six seven", &style(w * 0.5, 60.0), true, TextOverflow::Fit, 0.8, 0.3);
        assert!(f.size < 50.0 && f.text.contains('\n') && !f.clip);
    }
}
