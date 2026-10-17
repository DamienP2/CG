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
