//! Software render engine: turns resolved templates into RGBA frames.
//!
//! The renderer is CPU based (tiny-skia) so it runs headless on any server;
//! the scene evaluation is independent from the rasteriser so a GPU backend
//! (wgpu) can be added behind the same `Renderer` API.

mod text;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use cg_core::anim::{interpolate_text, resolve_layer, Data, ResolvedLayer};
use cg_core::widgets::{self, clock_text, scroll_positions, TimeCtx};
use cg_core::{
    ChannelState, Color, FontStyle, ImageFit, LayerKind, Project, Prop, Template, TextAlign, Value,
    VerticalAlign,
};
use tiny_skia::{FillRule, Mask, Paint, PathBuilder, Pixmap, PixmapPaint, Rect, Stroke, Transform};

pub use text::{FontStore, BUNDLED_FONTS};

/// QR modules of `content` (row-major, true = dark) and the side length,
/// shared with the HTML5 renderer so both draw the same code.
pub fn qr_modules(content: &str) -> Option<(usize, Vec<bool>)> {
    let code =
        qrcode::QrCode::with_error_correction_level(content.as_bytes(), qrcode::EcLevel::M).ok()?;
    Some((
        code.width(),
        code.to_colors()
            .into_iter()
            .map(|c| c == qrcode::Color::Dark)
            .collect(),
    ))
}

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
    time: TimeCtx<'a>,
}

/// Output raster of a channel. Projects designed for another size are
/// scaled to fit (letterboxed) and their timelines are re-timed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OutputFormat {
    pub width: u32,
    pub height: u32,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
    /// `default_tz` is the zone clocks use when they do not set one.
    pub fn render_channel(
        &mut self,
        project: &Project,
        state: &ChannelState,
        out: OutputFormat,
        default_tz: &str,
    ) -> Frame {
        let mut pm = Pixmap::new(out.width.max(1), out.height.max(1)).expect("valid size");
        let sx = out.width as f32 / project.width.max(1) as f32;
        let sy = out.height as f32 / project.height.max(1) as f32;
        let scale = sx.min(sy);
        let root = Transform::from_translate(
            (out.width as f32 - project.width as f32 * scale) / 2.0,
            (out.height as f32 - project.height as f32 * scale) / 2.0,
        )
        .pre_scale(scale, scale);
        let fps = project.frame_rate.as_f64().max(1.0);
        let now = now_ms();
        for item in state.layers.values() {
            if let Some(t) = project.template(&item.template_id) {
                let time = TimeCtx {
                    now_ms: now,
                    age_secs: item.age / fps,
                    default_tz,
                };
                let ctx = Ctx {
                    template: t,
                    frame: item.frame,
                    data: &item.data,
                    time,
                };
                self.draw_children(&mut pm, &ctx, None, root, 1.0, None);
            }
        }
        Frame {
            width: out.width,
            height: out.height,
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
        let time = TimeCtx {
            now_ms: now_ms(),
            age_secs: frame / project.frame_rate.as_f64().max(1.0),
            default_tz: "",
        };
        let ctx = Ctx {
            template,
            frame,
            data,
            time,
        };
        self.draw_children(&mut pm, &ctx, None, Transform::identity(), 1.0, None);
        Frame {
            width: project.width,
            height: project.height,
            data: pm.take(),
            captured_at: SystemTime::now(),
        }
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

            self.draw_layer(pm, ctx, &r, tf, opacity, m);
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
        ctx: &Ctx,
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
            LayerKind::Clock {
                mode,
                format,
                timezone,
                target,
                font,
            } => {
                let text = clock_text(*mode, format, timezone, target, ctx.data, &ctx.time);
                let text = if font.uppercase {
                    text.to_uppercase()
                } else {
                    text
                };
                self.draw_text(
                    pm,
                    r,
                    font,
                    &text,
                    (font.align, font.vertical_align),
                    (0.0, 0.0, w, h),
                    tf,
                    opacity,
                    mask,
                );
            }
            LayerKind::Ticker {
                text,
                separator,
                speed,
                font,
            } => {
                let items: Vec<String> = interpolate_text(text, ctx.data)
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(String::from)
                    .collect();
                if items.is_empty() {
                    return;
                }
                let mut strip = items.join(separator) + separator;
                if font.uppercase {
                    strip = strip.to_uppercase();
                }
                let Some(f) = self.fonts.font(&font.font_family, font.font_weight) else {
                    return;
                };
                let size = r.num(Prop::FontSize) as f32;
                let cycle = text::text_width(&f, &strip, size, r.num(Prop::LetterSpacing) as f32)
                    + r.num(Prop::LetterSpacing) as f32;
                let Some(clip) =
                    Rect::from_xywh(0.0, 0.0, w, h).map(|rc| build_mask(pm, mask, rc, tf))
                else {
                    return;
                };
                for x in scroll_positions(w as f64, cycle as f64, speed * ctx.time.age_secs, true) {
                    let place = (TextAlign::Left, font.vertical_align);
                    self.draw_text(
                        pm,
                        r,
                        font,
                        &strip,
                        place,
                        (x as f32, 0.0, cycle, h),
                        tf,
                        opacity,
                        Some(&clip),
                    );
                }
            }
            LayerKind::Roll {
                text,
                speed,
                looping,
                font,
            } => {
                let mut body = interpolate_text(text, ctx.data);
                if font.uppercase {
                    body = body.to_uppercase();
                }
                let size = r.num(Prop::FontSize) as f32;
                let block = body.split('\n').count() as f32 * size * text::LINE_HEIGHT;
                // A screen-high gap before the roll comes round again.
                let cycle = if *looping { block + h } else { block };
                let Some(clip) =
                    Rect::from_xywh(0.0, 0.0, w, h).map(|rc| build_mask(pm, mask, rc, tf))
                else {
                    return;
                };
                for y in
                    scroll_positions(h as f64, cycle as f64, speed * ctx.time.age_secs, *looping)
                {
                    let place = (font.align, VerticalAlign::Top);
                    self.draw_text(
                        pm,
                        r,
                        font,
                        &body,
                        place,
                        (0.0, y as f32, w, block),
                        tf,
                        opacity,
                        Some(&clip),
                    );
                }
            }
            LayerKind::Image { fit, .. } => {
                if let Some(src) = r.image_src.clone() {
                    self.draw_image(pm, &src, *fit, w, h, tf, opacity, mask);
                }
            }
            LayerKind::AnalogClock {
                timezone,
                seconds,
                accent,
            } => {
                let (ha, ma, sa) = widgets::clock_hands(timezone, &ctx.time);
                let d = w.min(h);
                let (cx, cy, rad) = (w / 2.0, h / 2.0, d / 2.0);
                if let Some(face) = PathBuilder::from_circle(cx, cy, rad) {
                    pm.fill_path(&face, &fill, FillRule::Winding, tf, mask);
                }
                let ink = paint_for(r.color(Prop::Stroke), opacity);
                let line = |pb: &mut PathBuilder, deg: f32, r0: f32, r1: f32| {
                    let (sn, cs) = deg.to_radians().sin_cos();
                    pb.move_to(cx + sn * r0, cy - cs * r0);
                    pb.line_to(cx + sn * r1, cy - cs * r1);
                };
                let stroke = |width: f32| Stroke {
                    width,
                    line_cap: tiny_skia::LineCap::Round,
                    ..Default::default()
                };
                let mut ticks = PathBuilder::new();
                for i in 0..12 {
                    line(
                        &mut ticks,
                        i as f32 * 30.0,
                        rad * if i % 3 == 0 { 0.78 } else { 0.84 },
                        rad * 0.92,
                    );
                }
                if let Some(p) = ticks.finish() {
                    pm.stroke_path(&p, &ink, &stroke((d * 0.02).max(1.5)), tf, mask);
                }
                for (deg, len, width) in [(ha, 0.5, 0.06), (ma, 0.74, 0.04)] {
                    let mut pb = PathBuilder::new();
                    line(&mut pb, deg as f32, -rad * 0.08, rad * len);
                    if let Some(p) = pb.finish() {
                        pm.stroke_path(&p, &ink, &stroke(d * width), tf, mask);
                    }
                }
                let accent = paint_for(Color::from_hex(accent).unwrap_or(Color::WHITE), opacity);
                if *seconds {
                    let mut pb = PathBuilder::new();
                    line(&mut pb, sa as f32, -rad * 0.15, rad * 0.86);
                    if let Some(p) = pb.finish() {
                        pm.stroke_path(&p, &accent, &stroke((d * 0.012).max(1.0)), tf, mask);
                    }
                }
                if let Some(dot) = PathBuilder::from_circle(cx, cy, d * 0.035) {
                    pm.fill_path(
                        &dot,
                        if *seconds { &accent } else { &ink },
                        FillRule::Winding,
                        tf,
                        mask,
                    );
                }
            }
            LayerKind::Counter {
                from,
                to,
                duration,
                decimals,
                prefix,
                suffix,
                grouping,
                font,
            } => {
                let text = widgets::counter_text(
                    from,
                    to,
                    *duration,
                    *decimals,
                    prefix,
                    suffix,
                    *grouping,
                    ctx.data,
                    ctx.time.age_secs,
                );
                self.draw_text(
                    pm,
                    r,
                    font,
                    &text,
                    (font.align, font.vertical_align),
                    (0.0, 0.0, w, h),
                    tf,
                    opacity,
                    mask,
                );
            }
            LayerKind::Progress {
                value,
                max,
                duration,
                track,
            } => {
                let ratio =
                    widgets::progress_ratio(value, max, *duration, ctx.data, ctx.time.age_secs)
                        as f32;
                let radius = r.num(Prop::CornerRadius) as f32;
                let track_paint = paint_for(
                    Color::from_hex(track).unwrap_or(Color::TRANSPARENT),
                    opacity,
                );
                if let Some(p) = rounded_rect(w, h, radius) {
                    pm.fill_path(&p, &track_paint, FillRule::Winding, tf, mask);
                }
                if let Some(p) = rounded_rect(w * ratio, h, radius.min(w * ratio / 2.0)) {
                    pm.fill_path(&p, &fill, FillRule::Winding, tf, mask);
                }
            }
            LayerKind::Rotator {
                text,
                interval,
                fade,
                font,
            } => {
                let items = widgets::lines(text, ctx.data);
                if items.is_empty() {
                    return;
                }
                let (idx, alpha) =
                    widgets::rotator_state(items.len(), *interval, *fade, ctx.time.age_secs);
                let item = if font.uppercase {
                    items[idx].to_uppercase()
                } else {
                    items[idx].clone()
                };
                self.draw_text(
                    pm,
                    r,
                    font,
                    &item,
                    (font.align, font.vertical_align),
                    (0.0, 0.0, w, h),
                    tf,
                    opacity * alpha as f32,
                    mask,
                );
            }
            LayerKind::Typewriter {
                text,
                speed,
                cursor,
                font,
            } => {
                let shown =
                    widgets::typewriter_text(text, *speed, *cursor, ctx.data, ctx.time.age_secs);
                let shown = if font.uppercase {
                    shown.to_uppercase()
                } else {
                    shown
                };
                self.draw_text(
                    pm,
                    r,
                    font,
                    &shown,
                    (font.align, font.vertical_align),
                    (0.0, 0.0, w, h),
                    tf,
                    opacity,
                    mask,
                );
            }
            LayerKind::Slideshow {
                images,
                interval,
                fade,
                fit,
            } => {
                let list = widgets::lines(images, ctx.data);
                if list.is_empty() {
                    return;
                }
                let (cur, next, mix) =
                    widgets::slideshow_state(list.len(), *interval, *fade, ctx.time.age_secs);
                self.draw_image(
                    pm,
                    &list[cur],
                    *fit,
                    w,
                    h,
                    tf,
                    opacity * (1.0 - mix as f32),
                    mask,
                );
                if mix > 0.0 {
                    self.draw_image(pm, &list[next], *fit, w, h, tf, opacity * mix as f32, mask);
                }
            }
            LayerKind::QrCode { data, background } => {
                let content = interpolate_text(data, ctx.data);
                let Some((n, modules)) = qr_modules(&content) else {
                    return;
                };
                let side = w.min(h);
                let cell = side / (n + 8) as f32; // 4-module quiet zone
                let (ox, oy) = ((w - side) / 2.0 + 4.0 * cell, (h - side) / 2.0 + 4.0 * cell);
                let bg = paint_for(Color::from_hex(background).unwrap_or(Color::WHITE), opacity);
                if let Some(rc) = Rect::from_xywh((w - side) / 2.0, (h - side) / 2.0, side, side) {
                    pm.fill_rect(rc, &bg, tf, mask);
                }
                let mut pb = PathBuilder::new();
                for (i, dark) in modules.iter().enumerate() {
                    if *dark {
                        let (x, y) = ((i % n) as f32, (i / n) as f32);
                        if let Some(rc) =
                            Rect::from_xywh(ox + x * cell, oy + y * cell, cell + 0.02, cell + 0.02)
                        {
                            pb.push_rect(rc);
                        }
                    }
                }
                if let Some(p) = pb.finish() {
                    pm.fill_path(&p, &fill, FillRule::Winding, tf, mask);
                }
            }
            LayerKind::BarChart {
                text,
                percent,
                duration,
                track,
                text_color,
                font,
            } => {
                let rows = widgets::chart_rows(text, ctx.data);
                if rows.is_empty() {
                    return;
                }
                let total: f64 = rows.iter().map(|(_, v)| v.max(0.0)).sum();
                let max = rows.iter().map(|(_, v)| *v).fold(0.0_f64, f64::max);
                let grow = widgets::grow(*duration, ctx.time.age_secs) as f32;
                let row_h = h / rows.len() as f32;
                let (label_w, value_w) = (w * 0.28, w * 0.16);
                let bar_x = label_w + w * 0.02;
                let bar_w = (w - label_w - value_w - w * 0.04).max(0.0);
                let track_paint = paint_for(
                    Color::from_hex(track).unwrap_or(Color::TRANSPARENT),
                    opacity,
                );
                let text_r = ResolvedLayer {
                    values: {
                        let mut v = r.values.clone();
                        v.insert(
                            Prop::Fill,
                            Value::Color(Color::from_hex(text_color).unwrap_or(Color::WHITE)),
                        );
                        v.insert(Prop::StrokeWidth, Value::Number(0.0));
                        v
                    },
                    ..r.clone()
                };
                for (i, (label, v)) in rows.iter().enumerate() {
                    let y = i as f32 * row_h;
                    let bh = row_h * 0.56;
                    let by = y + (row_h - bh) / 2.0;
                    if let Some(p) = rounded_rect(bar_w, bh, bh / 4.0) {
                        pm.fill_path(
                            &p,
                            &track_paint,
                            FillRule::Winding,
                            tf.pre_translate(bar_x, by),
                            mask,
                        );
                    }
                    let frac = if max > 0.0 {
                        (v / max).clamp(0.0, 1.0) as f32
                    } else {
                        0.0
                    };
                    if let Some(p) = rounded_rect(bar_w * frac * grow, bh, bh / 4.0) {
                        pm.fill_path(
                            &p,
                            &fill,
                            FillRule::Winding,
                            tf.pre_translate(bar_x, by),
                            mask,
                        );
                    }
                    let label = if font.uppercase {
                        label.to_uppercase()
                    } else {
                        label.clone()
                    };
                    self.draw_text(
                        pm,
                        &text_r,
                        font,
                        &label,
                        (TextAlign::Left, VerticalAlign::Middle),
                        (0.0, y, label_w, row_h),
                        tf,
                        opacity,
                        mask,
                    );
                    let shown = if *percent {
                        let pct = if total > 0.0 { v / total * 100.0 } else { 0.0 };
                        format!("{}%", widgets::format_number(pct * grow as f64, 0, false))
                    } else {
                        widgets::format_number(
                            v * grow as f64,
                            if v.fract() == 0.0 { 0 } else { 1 },
                            true,
                        )
                    };
                    self.draw_text(
                        pm,
                        &text_r,
                        font,
                        &shown,
                        (TextAlign::Right, VerticalAlign::Middle),
                        (w - value_w, y, value_w, row_h),
                        tf,
                        opacity,
                        mask,
                    );
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_image(
        &mut self,
        pm: &mut Pixmap,
        src: &str,
        fit: ImageFit,
        w: f32,
        h: f32,
        tf: Transform,
        opacity: f32,
        mask: Option<&Mask>,
    ) {
        if opacity <= 0.0 {
            return;
        }
        // Cover: clip to the layer box.
        let cover_mask = if fit == ImageFit::Cover {
            Rect::from_xywh(0.0, 0.0, w, h).map(|rc| build_mask(pm, mask, rc, tf))
        } else {
            None
        };
        let Some(img) = self.image(src) else { return };
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
        let img_tf = tf
            .pre_translate((w - iw * sx) / 2.0, (h - ih * sy) / 2.0)
            .pre_scale(sx, sy);
        let paint = PixmapPaint {
            opacity,
            quality: tiny_skia::FilterQuality::Bicubic,
            ..Default::default()
        };
        pm.draw_pixmap(
            0,
            0,
            img.as_ref(),
            &paint,
            img_tf,
            cover_mask.as_ref().or(mask),
        );
    }

    /// Draws `content` with a widget's font inside the box (x, y, w, h)
    /// of the layer.
    #[allow(clippy::too_many_arguments)]
    fn draw_text(
        &mut self,
        pm: &mut Pixmap,
        r: &ResolvedLayer,
        font: &FontStyle,
        content: &str,
        (align, vertical_align): (TextAlign, VerticalAlign),
        (x, y, w, h): (f32, f32, f32, f32),
        tf: Transform,
        opacity: f32,
        mask: Option<&Mask>,
    ) {
        if content.is_empty() {
            return;
        }
        let Some(f) = self.fonts.font(&font.font_family, font.font_weight) else {
            tracing::warn!(font = font.font_family, "no font available");
            return;
        };
        let style = text::TextStyle {
            size: r.num(Prop::FontSize) as f32,
            letter_spacing: r.num(Prop::LetterSpacing) as f32,
            align,
            vertical_align,
            box_w: w,
            box_h: h,
        };
        let Some(path) = text::layout_text(&f, content, &style) else {
            return;
        };
        let tf = tf.pre_translate(x, y);
        pm.fill_path(
            &path,
            &paint_for(r.color(Prop::Fill), opacity),
            FillRule::Winding,
            tf,
            mask,
        );
        let stroke_w = r.num(Prop::StrokeWidth) as f32;
        if stroke_w > 0.0 {
            let stroke = Stroke {
                width: stroke_w,
                ..Default::default()
            };
            pm.stroke_path(
                &path,
                &paint_for(r.color(Prop::Stroke), opacity),
                &stroke,
                tf,
                mask,
            );
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
    for px in data.as_chunks_mut::<4>().0 {
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

    const OUT: OutputFormat = OutputFormat {
        width: 1920,
        height: 1080,
    };

    #[test]
    fn widgets_render_and_scale() {
        let project = sample::demo_project();
        let mut state = ChannelState::default();
        for (layer, id) in [
            (30, "clock"),
            (31, "analog-clock"),
            (40, "ticker"),
            (50, "credits"),
            (60, "poll"),
            (70, "qr-code"),
            (80, "countdown"),
        ] {
            state
                .apply(
                    &project,
                    Command::Take {
                        zone: None,
                        layer: Some(layer),
                        template_id: id.into(),
                        data: None,
                        rundown_id: None,
                    },
                )
                .unwrap();
        }
        for _ in 0..200 {
            state.tick(1.0);
        }
        let mut r = Renderer::new(std::env::temp_dir().join("cg-render-test-assets"));
        // Half-size channel: the project is scaled down.
        let f = r.render_channel(
            &project,
            &state,
            OutputFormat {
                width: 960,
                height: 540,
            },
            "UTC",
        );
        assert_eq!((f.width, f.height), (960, 540));
        if let Ok(path) = std::env::var("CG_DUMP_WIDGETS") {
            std::fs::write(path, f.to_png()).unwrap();
        }
        let alpha = |x: usize, y: usize| f.data[(y * 960 + x) * 4 + 3];
        // Ticker bar along the bottom (y 990..1050 -> 495..525), under the credits shade.
        assert!(alpha(600, 510) > 240);
        // Clock plate top right (1640..1840 x 60..124 -> 820..920 x 30..62).
        assert!(alpha(825, 33) > 240);
    }

    #[test]
    fn renders_demo_lower_third() {
        let project = sample::demo_project();
        let mut state = ChannelState::default();
        state
            .apply(
                &project,
                Command::Take {
                    zone: None,
                    layer: Some(1),
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
        let f = r.render_channel(&project, &state, OUT, "UTC");
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
