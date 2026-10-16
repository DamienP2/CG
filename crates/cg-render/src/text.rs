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
        }
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
}

/// Line height multiplier — must match the web renderer (`line-height: 1.2`).
pub const LINE_HEIGHT: f32 = 1.2;

/// Builds a single path containing all glyphs, in layer-local coordinates.
pub fn layout_text(font: &FontArc, text: &str, style: &TextStyle) -> Option<SkPath> {
    // CSS `font-size` is the em size; ab_glyph's PxScale is ascent-descent.
    let upem = font.units_per_em().unwrap_or(1000.0);
    let px = ab_glyph::PxScale::from(style.size * font.height_unscaled() / upem);
    let scaled = font.as_scaled(px);
    let line_h = style.size * LINE_HEIGHT;
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
