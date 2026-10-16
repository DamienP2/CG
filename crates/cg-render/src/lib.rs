//! Software render engine: turns resolved templates into RGBA frames.
//!
//! The renderer is CPU based (tiny-skia) so it runs headless on any server;
//! the scene evaluation is independent from the rasteriser so a GPU backend
//! (wgpu) can be added behind the same `Renderer` API.

mod text;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use cg_core::anim::{resolve_layer, Data, ResolvedLayer};
use cg_core::{ChannelState, Color, ImageFit, LayerKind, Project, Prop, Template};
use tiny_skia::{FillRule, Mask, Paint, PathBuilder, Pixmap, PixmapPaint, Rect, Stroke, Transform};

pub use text::FontStore;

/// A rendered video frame, RGBA 8-bit **premultiplied** alpha.
#[derive(Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    /// Wall-clock time the frame was produced (drives RTP timestamps).
    pub captured_at: SystemTime,
}

impl Frame {
    pub fn blank(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0; (width * height * 4) as usize],
            captured_at: SystemTime::now(),
        }
    }

    /// Encodes as PNG (straight alpha), for previews and thumbnails.
    pub fn to_png(&self) -> Vec<u8> {
        let pm = Pixmap::from_vec(
            self.data.clone(),
            tiny_skia::IntSize::from_wh(self.width, self.height).unwrap(),
        );
        pm.and_then(|p| p.encode_png().ok()).unwrap_or_default()
    }
}

pub struct Renderer {
    fonts: FontStore,
    assets_dir: PathBuf,
    images: HashMap<String, Option<Pixmap>>,
}

struct Ctx<'a> {
    template: &'a Template,
    frame: f64,
    data: &'a Data,
}

impl Renderer {
    pub fn new(assets_dir: impl Into<PathBuf>) -> Self {
        let assets_dir = assets_dir.into();
        let fonts = FontStore::new(Some(&assets_dir.join("fonts")));
        Self {
            fonts,
            assets_dir,
            images: HashMap::new(),
        }
    }

    /// Forgets cached images (call after an asset upload).
    pub fn invalidate_assets(&mut self) {
        self.images.clear();
    }

    /// Composites every playout layer of a channel, lowest layer first.
    pub fn render_channel(&mut self, project: &Project, state: &ChannelState) -> Frame {
        let mut pm = Pixmap::new(project.width, project.height).expect("valid size");
        for item in state.layers.values() {
            if let Some(t) = project.template(&item.template_id) {
                self.draw_template(&mut pm, t, item.frame, &item.data);
            }
        }
        Frame {
            width: project.width,
            height: project.height,
            data: pm.take(),
            captured_at: SystemTime::now(),
        }
    }

    /// Renders a single template at `frame` (used for thumbnails / previews).
    pub fn render_template(
        &mut self,
        project: &Project,
        template: &Template,
        frame: f64,
        data: &Data,
    ) -> Frame {
        let mut pm = Pixmap::new(project.width, project.height).expect("valid size");
        self.draw_template(&mut pm, template, frame, data);
        Frame {
            width: project.width,
            height: project.height,
            data: pm.take(),
            captured_at: SystemTime::now(),
        }
    }

    fn draw_template(&mut self, pm: &mut Pixmap, template: &Template, frame: f64, data: &Data) {
        let ctx = Ctx {
            template,
            frame,
            data,
        };
        self.draw_children(pm, &ctx, None, Transform::identity(), 1.0, None);
    }

    fn draw_children(
        &mut self,
        pm: &mut Pixmap,
        ctx: &Ctx,
        parent: Option<&str>,
        parent_tf: Transform,
        parent_opacity: f32,
        mask: Option<&Mask>,
    ) {
        let children: Vec<_> = ctx
            .template
            .layers
            .iter()
            .filter(|l| l.visible && l.parent.as_deref() == parent)
            .collect();
        for layer in children {
            let r = resolve_layer(layer, ctx.frame, ctx.data);
            let opacity = parent_opacity * r.num(Prop::Opacity).clamp(0.0, 1.0) as f32;
            if opacity <= 0.0 {
                continue;
            }
            let (w, h) = (r.num(Prop::Width) as f32, r.num(Prop::Height) as f32);
            let tf = parent_tf.pre_concat(local_transform(&r, w, h));

            // Crop (reveal mask) in layer space, intersected with the parent mask.
            let crop = crop_rect(&r, w, h);
            let clip_children = matches!(layer.kind, LayerKind::Group { clip: true });
            let own_mask = if crop.is_some() || clip_children {
                let rect =
                    crop.unwrap_or_else(|| Rect::from_xywh(0.0, 0.0, w.max(0.0), h.max(0.0)));
                match rect {
                    Some(rect) => Some(build_mask(pm, mask, rect, tf)),
                    None => continue, // fully cropped
                }
            } else {
                None
            };
            let m = own_mask.as_ref().or(mask);

            self.draw_layer(pm, &r, tf, opacity, m);
            if matches!(layer.kind, LayerKind::Group { .. }) {
                // Group crop always applies to children; plain clip only when requested.
                let child_mask = if clip_children || crop.is_some() {
                    m
                } else {
                    mask
                };
                self.draw_children(pm, ctx, Some(&layer.id), tf, opacity, child_mask);
            }
        }
    }

    fn draw_layer(
        &mut self,
        pm: &mut Pixmap,
        r: &ResolvedLayer,
        tf: Transform,
        opacity: f32,
        mask: Option<&Mask>,
    ) {
        let (w, h) = (r.num(Prop::Width) as f32, r.num(Prop::Height) as f32);
        let fill = paint_for(r.color(Prop::Fill), opacity);
        let stroke_w = r.num(Prop::StrokeWidth) as f32;
        let stroke = paint_for(r.color(Prop::Stroke), opacity);
        match &r.layer.kind {
            LayerKind::Group { .. } => {
                // Groups paint a background only if a visible fill is set explicitly.
                if r.layer.props.contains_key(&Prop::Fill)
                    || r.layer.tracks.contains_key(&Prop::Fill)
                {
                    if let Some(path) = rounded_rect(w, h, r.num(Prop::CornerRadius) as f32) {
                        pm.fill_path(&path, &fill, FillRule::Winding, tf, mask);
                    }
                }
            }
            LayerKind::Rect => {
                if let Some(path) = rounded_rect(w, h, r.num(Prop::CornerRadius) as f32) {
                    pm.fill_path(&path, &fill, FillRule::Winding, tf, mask);
                    if stroke_w > 0.0 {
                        pm.stroke_path(
                            &path,
                            &stroke,
                            &Stroke {
                                width: stroke_w,
                                ..Default::default()
                            },
                            tf,
                            mask,
                        );
                    }
                }
            }
            LayerKind::Ellipse => {
                if let Some(path) = Rect::from_xywh(0.0, 0.0, w, h).and_then(PathBuilder::from_oval)
                {
                    pm.fill_path(&path, &fill, FillRule::Winding, tf, mask);
                    if stroke_w > 0.0 {
                        pm.stroke_path(
                            &path,
                            &stroke,
                            &Stroke {
                                width: stroke_w,
                                ..Default::default()
                            },
                            tf,
                            mask,
                        );
                    }
                }
            }
            LayerKind::Text {
                font_family,
                font_weight,
                align,
                vertical_align,
                ..
            } => {
                let Some(content) = r.text.as_deref().filter(|t| !t.is_empty()) else {
                    return;
                };
                let Some(font) = self.fonts.font(font_family, *font_weight) else {
                    tracing::warn!(font_family, "no font available");
                    return;
                };
                let style = text::TextStyle {
                    size: r.num(Prop::FontSize) as f32,
                    letter_spacing: r.num(Prop::LetterSpacing) as f32,
                    align: *align,
                    vertical_align: *vertical_align,
                    box_w: w,
                    box_h: h,
                };
                if let Some(path) = text::layout_text(&font, content, &style) {
                    pm.fill_path(&path, &fill, FillRule::Winding, tf, mask);
                    if stroke_w > 0.0 {
                        pm.stroke_path(
                            &path,
                            &stroke,
                            &Stroke {
                                width: stroke_w,
                                ..Default::default()
                            },
                            tf,
                            mask,
                        );
                    }
                }
            }
            LayerKind::Image { fit, .. } => {
                let Some(src) = r.image_src.clone() else {
                    return;
                };
                let Some(img) = self.image(&src) else { return };
                let (iw, ih) = (img.width() as f32, img.height() as f32);
                let (sx, sy) = match fit {
                    ImageFit::Stretch => (w / iw, h / ih),
                    ImageFit::Contain => {
                        let s = (w / iw).min(h / ih);
                        (s, s)
                    }
                    ImageFit::Cover => {
                        let s = (w / iw).max(h / ih);
                        (s, s)
                    }
                };
                let ox = (w - iw * sx) / 2.0;
                let oy = (h - ih * sy) / 2.0;
                let img_tf = tf.pre_translate(ox, oy).pre_scale(sx, sy);
                let paint = PixmapPaint {
                    opacity,
                    quality: tiny_skia::FilterQuality::Bicubic,
                    ..Default::default()
                };
                // Cover: clip to the layer box.
                let cover_mask;
                let m = if *fit == ImageFit::Cover {
                    cover_mask =
                        Rect::from_xywh(0.0, 0.0, w, h).map(|rc| build_mask(pm, mask, rc, tf));
                    cover_mask.as_ref().or(mask)
                } else {
                    mask
                };
                pm.draw_pixmap(0, 0, img.as_ref(), &paint, img_tf, m);
            }
        }
    }

    fn image(&mut self, src: &str) -> Option<&Pixmap> {
        if !self.images.contains_key(src) {
            let loaded = load_image(&self.assets_dir, src);
            if loaded.is_none() {
                tracing::warn!(src, "image not found or unreadable");
            }
            self.images.insert(src.to_string(), loaded);
        }
        self.images.get(src).and_then(Option::as_ref)
    }
}

fn load_image(assets_dir: &Path, src: &str) -> Option<Pixmap> {
    let name = src.trim().strip_prefix("/assets/")?;
    if name.contains("..") {
        return None;
    }
    let img = image::open(assets_dir.join(name)).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    let mut data = img.into_raw();
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u16;
        for c in &mut px[..3] {
            *c = ((*c as u16 * a + 127) / 255) as u8;
        }
    }
    Pixmap::from_vec(data, tiny_skia::IntSize::from_wh(w, h)?)
}

/// Same convention as the web renderer: position is the top-left of the box
/// in parent space, rotation/scale happen around the anchor point.
fn local_transform(r: &ResolvedLayer, w: f32, h: f32) -> Transform {
    let ax = r.num(Prop::AnchorX) as f32 * w;
    let ay = r.num(Prop::AnchorY) as f32 * h;
    Transform::from_translate(r.num(Prop::X) as f32 + ax, r.num(Prop::Y) as f32 + ay)
        .pre_rotate(r.num(Prop::Rotation) as f32)
        .pre_scale(r.num(Prop::ScaleX) as f32, r.num(Prop::ScaleY) as f32)
        .pre_translate(-ax, -ay)
}

/// Returns `None` when no crop is set, `Some(None)` when fully cropped.
fn crop_rect(r: &ResolvedLayer, w: f32, h: f32) -> Option<Option<Rect>> {
    let (l, rt, t, b) = (
        r.num(Prop::CropLeft) as f32,
        r.num(Prop::CropRight) as f32,
        r.num(Prop::CropTop) as f32,
        r.num(Prop::CropBottom) as f32,
    );
    if l <= 0.0 && rt <= 0.0 && t <= 0.0 && b <= 0.0 {
        return None;
    }
    let x0 = w * l.clamp(0.0, 1.0);
    let x1 = w * (1.0 - rt.clamp(0.0, 1.0));
    let y0 = h * t.clamp(0.0, 1.0);
    let y1 = h * (1.0 - b.clamp(0.0, 1.0));
    Some(Rect::from_ltrb(x0, y0, x1, y1))
}

fn build_mask(pm: &Pixmap, parent: Option<&Mask>, rect: Rect, tf: Transform) -> Mask {
    let path = PathBuilder::from_rect(rect);
    match parent {
        Some(p) => {
            let mut m = p.clone();
            m.intersect_path(&path, FillRule::Winding, true, tf);
            m
        }
        None => {
            let mut m = Mask::new(pm.width(), pm.height()).expect("valid size");
            m.fill_path(&path, FillRule::Winding, true, tf);
            m
        }
    }
}

fn paint_for(c: Color, opacity: f32) -> Paint<'static> {
    let [r, g, b, a] = c.0;
    let mut p = Paint::default();
    p.set_color(
        tiny_skia::Color::from_rgba(
            r.clamp(0.0, 1.0),
            g.clamp(0.0, 1.0),
            b.clamp(0.0, 1.0),
            (a * opacity).clamp(0.0, 1.0),
        )
        .unwrap_or(tiny_skia::Color::TRANSPARENT),
    );
    p.anti_alias = true;
    p
}

fn rounded_rect(w: f32, h: f32, radius: f32) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let r = radius.clamp(0.0, w.min(h) / 2.0);
    if r <= 0.0 {
        return Some(PathBuilder::from_rect(Rect::from_xywh(0.0, 0.0, w, h)?));
    }
    // Circular arcs approximated with cubics (kappa).
    let k = r * 0.552_284_8;
    let mut pb = PathBuilder::new();
    pb.move_to(r, 0.0);
    pb.line_to(w - r, 0.0);
    pb.cubic_to(w - r + k, 0.0, w, r - k, w, r);
    pb.line_to(w, h - r);
    pb.cubic_to(w, h - r + k, w - r + k, h, w - r, h);
    pb.line_to(r, h);
    pb.cubic_to(r - k, h, 0.0, h - r + k, 0.0, h - r);
    pb.line_to(0.0, r);
    pb.cubic_to(0.0, r - k, r - k, 0.0, r, 0.0);
    pb.close();
    pb.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_core::{sample, Command};

    #[test]
    fn renders_demo_lower_third() {
        let project = sample::demo_project();
        let mut state = ChannelState::default();
        state
            .apply(
                &project,
                Command::Take {
                    layer: 1,
                    template_id: "lower-third".into(),
                    data: None,
                    rundown_id: None,
                },
            )
            .unwrap();
        for _ in 0..40 {
            state.tick(1.0);
        }
        let mut r = Renderer::new(std::env::temp_dir().join("cg-render-test-assets"));
        let f = r.render_channel(&project, &state);
        assert_eq!(f.data.len(), 1920 * 1080 * 4);
        // The red accent bar at (160..174, 820..970) must be opaque.
        let px = |x: usize, y: usize| &f.data[(y * 1920 + x) * 4..(y * 1920 + x) * 4 + 4];
        assert_eq!(px(165, 900)[3], 255);
        assert!(px(165, 900)[0] > 200);
        // Outside the graphic stays transparent.
        assert_eq!(px(10, 10)[3], 0);
        if let Ok(path) = std::env::var("CG_DUMP_PNG") {
            std::fs::write(path, f.to_png()).unwrap();
        }
    }
}
