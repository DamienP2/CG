//! Software render engine: turns resolved templates into RGBA frames.
//!
//! The renderer is CPU based (tiny-skia) so it runs headless on any server;
//! the scene evaluation is independent from the rasteriser so a GPU backend
//! (wgpu) can be added behind the same `Renderer` API.

// Drawing functions take the canvas, the box, the style and the time: many arguments by nature.
#![allow(clippy::too_many_arguments, clippy::type_complexity)]

pub mod sequence;
mod text;
mod wid;

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

pub use text::{fonts_changed, FontFamily, FontStore, BUNDLED_FONTS};
pub use wid::qrcode::qr_modules_ec;

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
    font_generation: u64,
    assets_dir: PathBuf,
    images: HashMap<String, Option<Pixmap>>,
}

struct Ctx<'a> {
    template: &'a Template,
    frame: f64,
    data: &'a Data,
    time: TimeCtx<'a>,
    /// Values of the layers changed by the template's logic graph.
    logic: HashMap<String, std::collections::BTreeMap<Prop, Value>>,
    /// The graphic on air (widget clocks the operator controls), and the
    /// project frame rate its ages are counted in.
    item: Option<&'a cg_core::PlayoutItem>,
    fps: f64,
    /// The project's language (texts without their own).
    lang: &'a str,
}

impl Ctx<'_> {
    /// Time inputs of one layer: its own clock when the operator controls it.
    fn time_for(&self, layer: &cg_core::Layer) -> TimeCtx<'_> {
        match self.item {
            Some(item) => TimeCtx {
                age_secs: item.layer_age(layer) / self.fps,
                ..self.time
            },
            None => self.time,
        }
    }
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
            font_generation: text::font_generation(),
            assets_dir,
            images: HashMap::new(),
        }
    }

    /// Picks up fonts added since the renderer was created.
    fn refresh_fonts(&mut self) {
        let g = text::font_generation();
        if g != self.font_generation {
            self.fonts = FontStore::new(Some(&self.assets_dir.join("fonts")));
            self.font_generation = g;
        }
    }

    /// Runs the template's logic graph; returns the layers it changed.
    fn logic_values(
        &mut self,
        t: &Template,
        frame: f64,
        data: &Data,
    ) -> HashMap<String, std::collections::BTreeMap<Prop, Value>> {
        if t.logic.is_empty() {
            return HashMap::new();
        }
        let hold = t.hold_frame();
        let mut values: cg_core::logic::Values = t
            .layers
            .iter()
            .map(|l| (l.id.clone(), resolve_layer(l, frame, data, hold).values))
            .collect();
        let fonts = &mut self.fonts;
        let mut measure = |id: &str,
                           v: &std::collections::BTreeMap<Prop, Value>,
                           metric: cg_core::logic::TextMetric|
         -> f64 {
            let Some(LayerKind::Text {
                text,
                font_family,
                font_weight,
                uppercase,
                transform,
                line_height,
                ..
            }) = t.layers.iter().find(|l| l.id == id).map(|l| &l.kind)
            else {
                return 0.0;
            };
            let mut content = interpolate_text(text, data);
            content = if *uppercase {
                content.to_uppercase()
            } else {
                transform.apply(&content)
            };
            let line_h = line_height.unwrap_or(text::LINE_HEIGHT) as f64;
            let num = |p: Prop| v.get(&p).and_then(Value::as_number).unwrap_or(0.0);
            let size = num(Prop::FontSize);
            let lines = content.split('\n').count() as f64;
            match metric {
                cg_core::logic::TextMetric::Lines => lines,
                cg_core::logic::TextMetric::Chars => content.chars().count() as f64,
                cg_core::logic::TextMetric::Height => {
                    if content.is_empty() {
                        0.0
                    } else {
                        lines * size * line_h
                    }
                }
                cg_core::logic::TextMetric::Width => match fonts.font(font_family, *font_weight) {
                    Some(f) if !content.is_empty() => {
                        text::text_width(&f, &content, size as f32, num(Prop::LetterSpacing) as f32)
                            as f64
                    }
                    _ => 0.0,
                },
            }
        };
        cg_core::logic::apply(&t.logic, &mut values, data, &mut measure);
        let targeted: std::collections::HashSet<&str> = t
            .logic
            .nodes
            .iter()
            .filter_map(|n| match &n.kind {
                cg_core::logic::NodeKind::Target { layer, .. } => Some(layer.as_str()),
                _ => None,
            })
            .collect();
        values.retain(|k, _| targeted.contains(k.as_str()));
        values
    }

    pub fn font_families(&mut self) -> Vec<FontFamily> {
        self.refresh_fonts();
        self.fonts.families()
    }

    pub fn font_file(&mut self, family: &str, weight: u16) -> Option<Vec<u8>> {
        self.refresh_fonts();
        self.fonts.file(family, weight)
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
        self.refresh_fonts();
        let mut pm = Pixmap::new(out.width.max(1), out.height.max(1)).expect("valid size");
        // The project layout (16:9, 9:16…) closest to this output's shape.
        let (format, dw, dh) = project.format_for(out.width, out.height);
        let sx = out.width as f32 / dw.max(1) as f32;
        let sy = out.height as f32 / dh.max(1) as f32;
        let scale = sx.min(sy);
        let root = Transform::from_translate(
            (out.width as f32 - dw as f32 * scale) / 2.0,
            (out.height as f32 - dh as f32 * scale) / 2.0,
        )
        .pre_scale(scale, scale);
        let fps = project.frame_rate.as_f64().max(1.0);
        let now = now_ms();
        let portrait = dh > dw;
        for (layer, item) in &state.layers {
            if let Some(t) = project.template(&item.template_id) {
                let t = t.in_format(format);
                // Settings the Operator was given (mask, font, logo…).
                let t = t.with_settings(&item.data);
                // Only what is inside the zone shows on air.
                let zone_mask = project
                    .zone_at(*layer)
                    .map(|z| z.area(format, portrait))
                    .filter(|a| !a.is_full())
                    .and_then(|a| {
                        Rect::from_xywh(
                            (a.x * dw as f64) as f32,
                            (a.y * dh as f64) as f32,
                            (a.width * dw as f64) as f32,
                            (a.height * dh as f64) as f32,
                        )
                    })
                    .map(|r| build_mask(&pm, None, r, root));
                let time = TimeCtx {
                    now_ms: now,
                    age_secs: item.age / fps,
                    default_tz,
                };
                let logic = self.logic_values(&t, item.frame, &item.data);
                let ctx = Ctx {
                    template: &t,
                    frame: item.frame,
                    data: &item.data,
                    time,
                    logic,
                    item: Some(item),
                    fps,
                    lang: &project.language,
                };
                self.draw_children(&mut pm, &ctx, None, root, 1.0, zone_mask.as_ref());
                // A data set row change: the old values fade out above.
                if let Some(f) = &item.fade {
                    let logic = self.logic_values(&t, item.frame, &f.data);
                    let old = Ctx {
                        data: &f.data,
                        logic,
                        ..ctx
                    };
                    self.draw_children(&mut pm, &old, None, root, f.opacity(), zone_mask.as_ref());
                }
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
    /// Renders a template in one of the project formats ("main", "vertical"…).
    pub fn render_template(
        &mut self,
        project: &Project,
        template: &Template,
        format: &str,
        frame: f64,
        data: &Data,
    ) -> Frame {
        self.refresh_fonts();
        let (width, height) = project
            .formats
            .iter()
            .find(|f| f.id == format)
            .map(|f| (f.width, f.height))
            .unwrap_or((project.width, project.height));
        let template = template.in_format(format);
        let template = &*template.with_settings(data);
        let mut pm = Pixmap::new(width.max(1), height.max(1)).expect("valid size");
        let time = TimeCtx {
            now_ms: now_ms(),
            age_secs: frame / project.frame_rate.as_f64().max(1.0),
            default_tz: "",
        };
        let logic = self.logic_values(template, frame, data);
        let ctx = Ctx {
            template,
            frame,
            data,
            time,
            logic,
            item: None,
            fps: project.frame_rate.as_f64().max(1.0),
            lang: &project.language,
        };
        // As on air: only what is inside the template's zone.
        let zone_mask = project
            .zone(&template.zone)
            .map(|z| z.area(format, height > width))
            .filter(|a| !a.is_full())
            .and_then(|a| {
                Rect::from_xywh(
                    (a.x * width as f64) as f32,
                    (a.y * height as f64) as f32,
                    (a.width * width as f64) as f32,
                    (a.height * height as f64) as f32,
                )
            })
            .map(|r| build_mask(&pm, None, r, Transform::identity()));
        self.draw_children(
            &mut pm,
            &ctx,
            None,
            Transform::identity(),
            1.0,
            zone_mask.as_ref(),
        );
        Frame {
            width: width.max(1),
            height: height.max(1),
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
            let mut r = resolve_layer(layer, ctx.frame, ctx.data, ctx.template.hold_frame());
            // Styles typed by the operator too: the text without their tags.
            if let Some(runs) = cg_core::rich::layer_runs(ctx.template, layer, ctx.data) {
                r.text = Some(runs.into_iter().map(|r| r.text).collect());
            }
            if let Some(v) = ctx.logic.get(&layer.id) {
                r.values = v.clone();
            }
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
        let time = ctx.time_for(r.layer);
        // The widgets of the spec draw themselves (src/wid).
        if cg_core::wid::widget_id(&r.layer.kind).is_some() {
            let null = serde_json::Value::Null;
            let state = ctx
                .item
                .and_then(|i| i.widgets.get(&r.layer.id))
                .unwrap_or(&null);
            let mut d = wid::Draw {
                rd: self,
                pm,
                r,
                layer: r.layer,
                tf,
                mask,
                opacity,
                w,
                h,
                time,
                data: ctx.data,
                frame: ctx.frame,
                hold: ctx.template.hold_frame(),
                fps: ctx.fps,
                state,
                lang: ctx.lang,
                runs: cg_core::rich::layer_runs(ctx.template, r.layer, ctx.data),
                follow: match &r.layer.kind {
                    LayerKind::Progress { x: c, .. } => {
                        let none = Default::default();
                        cg_core::wid::progress::followed(
                            &ctx.template.layers,
                            c,
                            ctx.item.map_or(&none, |i| &i.widgets),
                            ctx.data,
                            time.now_ms,
                            time.age_secs,
                            time.default_tz,
                        )
                    }
                    _ => None,
                },
            };
            if wid::draw(&mut d) {
                return;
            }
        }
        let fill = paint_for(r.color(Prop::Fill), opacity);
        let stroke_w = r.num(Prop::StrokeWidth) as f32;
        let stroke = paint_for(r.color(Prop::Stroke), opacity);
        // A scrolling text is drawn as the ticker or roll it behaves like.
        let scrolling = r.layer.kind.scrolling_as();
        let kind = scrolling.as_ref().unwrap_or(&r.layer.kind);
        // Widgets stay inside their box.
        let boxed;
        let mask = if matches!(
            kind,
            LayerKind::Clock { .. }
                | LayerKind::Counter { .. }
                | LayerKind::Typewriter { .. }
                | LayerKind::Rotator { .. }
                | LayerKind::BarChart { .. }
                | LayerKind::Slideshow { .. }
                | LayerKind::Ticker { .. }
                | LayerKind::Roll { .. }
        ) {
            boxed = Rect::from_xywh(0.0, 0.0, w.max(1.0), h.max(1.0))
                .map(|b| build_mask(pm, mask, b, tf));
            boxed.as_ref().or(mask)
        } else {
            mask
        };
        match kind {
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
            LayerKind::Rect { .. } => {
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
            LayerKind::Ellipse { .. } => {
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
                wrap,
                decoration,
                line_height,
                overflow,
                squeeze,
                min_size,
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
                    line_height: line_height.unwrap_or(text::LINE_HEIGHT),
                    decoration: *decoration,
                };
                // Too long for its box: narrower and smaller, "…", or cut.
                let fit = text::fit_text(
                    &font, content, &style, *wrap, *overflow, *squeeze, *min_size,
                );
                let style = text::TextStyle {
                    size: fit.size,
                    box_w: w / fit.squeeze,
                    ..style
                };
                let boxed;
                let mask = if fit.clip {
                    boxed = Rect::from_xywh(0.0, 0.0, w.max(1.0), h.max(1.0))
                        .map(|r| build_mask(pm, mask, r, tf));
                    boxed.as_ref().or(mask)
                } else {
                    mask
                };
                let tf = tf.pre_scale(fit.squeeze, 1.0);
                if let Some(path) = text::layout_text(&font, &fit.text, &style) {
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
                x: _,
                mode,
                format,
                timezone,
                target,
                font,
            } => {
                let text = clock_text(*mode, format, timezone, target, ctx.data, &time);
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
                x: _,
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
                for x in scroll_positions(w as f64, cycle as f64, speed * time.age_secs, true) {
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
                for y in scroll_positions(h as f64, cycle as f64, speed * time.age_secs, *looping) {
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
                let (ha, ma, sa) = widgets::clock_hands(timezone, &time);
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
                x: _,
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
                    time.age_secs,
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
                x: _,
                value,
                max,
                duration,
                track,
            } => {
                let ratio =
                    widgets::progress_ratio(value, max, *duration, ctx.data, time.age_secs) as f32;
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
                    widgets::rotator_state(items.len(), *interval, *fade, time.age_secs);
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
                x: _,
                text,
                speed,
                cursor,
                font,
            } => {
                let shown =
                    widgets::typewriter_text(text, *speed, *cursor, ctx.data, time.age_secs);
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
                    widgets::slideshow_state(list.len(), *interval, *fade, time.age_secs);
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
            // Drawn by src/wid (wid::draw returns true for them).
            LayerKind::Polygon { .. }
            | LayerKind::Pen { .. }
            | LayerKind::Table { .. }
            | LayerKind::Credits { .. }
            | LayerKind::Chart { .. }
            | LayerKind::Map { .. }
            | LayerKind::Scoreboard { .. }
            | LayerKind::Web { .. } => {}
            LayerKind::QrCode {
                data, background, ..
            } => {
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
                let grow = widgets::grow(*duration, time.age_secs) as f32;
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
            line_height: text::LINE_HEIGHT,
            decoration: cg_core::TextDecoration::None,
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
    let path = assets_dir.join(name);
    if name.to_ascii_lowercase().ends_with(".svg") {
        return load_svg(&path);
    }
    let img = image::open(path).ok()?.to_rgba8();
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

/// An SVG drawn into a picture (2048 px on its long side: sharp when scaled
/// down, as logos are).
fn load_svg(path: &Path) -> Option<Pixmap> {
    let data = std::fs::read(path).ok()?;
    let tree = resvg::usvg::Tree::from_data(&data, &resvg::usvg::Options::default()).ok()?;
    let size = tree.size();
    let k = 2048.0 / size.width().max(size.height()).max(1.0);
    let (w, h) = (
        (size.width() * k).round().max(1.0) as u32,
        (size.height() * k).round().max(1.0) as u32,
    );
    let mut pm = Pixmap::new(w, h)?;
    resvg::render(&tree, Transform::from_scale(k, k), &mut pm.as_mut());
    Some(pm)
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
    fn only_the_zone_shows_on_air() {
        let mut project = sample::demo_project();
        // The credits (a full-frame shade) taken in a top-left zone.
        project.zones = vec![cg_core::Zone {
            id: "top-left".into(),
            name: "Top left".into(),
            layer: 50,
            color: String::new(),
            transition: cg_core::ZoneTransition::Cut,
            areas: Default::default(),
        }];
        let mut state = ChannelState::default();
        state
            .apply(
                &project,
                Command::Take {
                    zone: None,
                    layer: Some(50),
                    template_id: "credits".into(),
                    data: None,
                    rundown_id: None,
                },
            )
            .unwrap();
        for _ in 0..60 {
            state.tick(1.0);
        }
        let mut r = Renderer::new(std::env::temp_dir().join("cg-render-test-assets"));
        let f = r.render_channel(&project, &state, OUT, "UTC");
        let alpha = |x: usize, y: usize| f.data[(y * 1920 + x) * 4 + 3];
        // Top-left zone: 4 %..28 % x 5 %..19 % of the frame.
        assert!(alpha(200, 100) > 0);
        assert_eq!(alpha(1500, 800), 0);
    }

    #[test]
    fn svg_pictures_are_drawn() {
        let dir = std::env::temp_dir().join("cg-render-svg-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("dot.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20" fill="#00ff00"/></svg>"##,
        )
        .unwrap();
        let pm = load_svg(&dir.join("dot.svg")).expect("drawn");
        assert_eq!((pm.width(), pm.height()), (1024, 2048));
        let p = pm.pixel(500, 1000).unwrap();
        assert_eq!((p.red(), p.green(), p.blue(), p.alpha()), (0, 255, 0, 255));
        assert!(load_image(&dir, "/assets/dot.svg").is_some());
    }

    #[test]
    fn a_timer_with_an_analog_face_draws_its_face_and_hands() {
        let project = sample::demo_project();
        let t: cg_core::Template = serde_json::from_value(serde_json::json!({
            "id": "ac", "name": "T", "duration": 50.0, "markers": [], "zone": "", "fields": [],
            "layers": [{
                "id": "c", "name": "Clock", "type": "clock", "timerMode": "countdown", "cdDuration": 11730000, "face": "analog",
                "analog": {"face": "#0000ff", "hands": "#ffffff", "accent": "#ff0000", "ticks": "hours"},
                "props": {"x": 0.0, "y": 0.0, "width": 400.0, "height": 400.0, "fill": [1.0, 1.0, 1.0, 1.0]}
            }]
        }))
        .unwrap();
        let mut r = Renderer::new(std::env::temp_dir().join("cg-render-test-assets"));
        let f = r.render_template(&project, &t, "main", 0.0, &Default::default());
        let px = |x: u32, y: u32| {
            let i = ((y * f.width + x) * 4) as usize;
            [f.data[i], f.data[i + 1], f.data[i + 2], f.data[i + 3]]
        };
        // A countdown not started yet shows 3:15:30 (hands away from 12): blue face,
        // nothing in the corner, the red dot of the second hand at the centre.
        assert_eq!(px(200, 60), [0, 0, 255, 255]);
        assert_eq!(px(5, 5)[3], 0);
        assert_eq!(px(200, 200), [255, 0, 0, 255]);
        // The 12 o'clock mark is white.
        assert_eq!(px(200, 26), [255, 255, 255, 255]);
    }

    #[test]
    fn a_scrolling_text_comes_in_from_the_right_with_its_looks() {
        let project = sample::demo_project();
        let t: cg_core::Template = serde_json::from_value(serde_json::json!({
            "id": "sc", "name": "T", "duration": 500.0, "markers": [], "zone": "", "fields": [],
            "layers": [{
                "id": "t", "name": "Ticker", "type": "text", "fontFamily": "Inter",
                "text": "Breaking <c=#00ff00>news</c>\nSecond line", "scroll": "horizontal", "speed": 600.0,
                "band": true, "bandColor": "#0000ff",
                "props": {"x": 0.0, "y": 0.0, "width": 1920.0, "height": 120.0, "fontSize": 60.0, "fill": [1.0, 0.0, 0.0, 1.0]}
            }]
        }))
        .unwrap();
        let mut r = Renderer::new(std::env::temp_dir().join("cg-render-test-assets"));
        let fps = project.frame_rate.as_f64();
        let seen = |f: &Frame| f.data.chunks(4).filter(|p| p[3] > 200).count();
        let count = |f: &Frame, want: [u8; 3]| {
            f.data
                .chunks(4)
                .filter(|p| p[3] == 255 && p[..3] == want)
                .count()
        };
        // At the take it starts beyond the right edge.
        assert_eq!(
            seen(&r.render_template(&project, &t, "main", 0.0, &Default::default())),
            0
        );
        // Two seconds later: on screen, with its band and its green part.
        let f = r.render_template(&project, &t, "main", 2.0 * fps, &Default::default());
        assert!(count(&f, [0, 0, 255]) > 1000, "band");
        assert!(count(&f, [0, 255, 0]) > 200, "rich text");
        assert!(count(&f, [255, 0, 0]) > 200, "text");
    }

    #[test]
    fn styled_parts_of_a_text_have_their_colour() {
        let project = sample::demo_project();
        let t: cg_core::Template = serde_json::from_value(serde_json::json!({
            "id": "rt", "name": "T", "duration": 10.0, "markers": [], "zone": "",
            "fields": [{"key": "v", "label": "V", "kind": "text", "default": ""}],
            "layers": [{
                "id": "t", "name": "Text", "type": "text", "fontFamily": "Inter",
                "text": "MMMM <c=#00ff00>MMMM</c> {{v}}",
                "props": {"x": 0.0, "y": 0.0, "width": 1600.0, "height": 200.0, "fontSize": 120.0, "fill": [1.0, 0.0, 0.0, 1.0]}
            }]
        }))
        .unwrap();
        let mut r = Renderer::new(std::env::temp_dir().join("cg-render-test-assets"));
        let count = |f: &Frame, want: [u8; 3]| {
            f.data
                .chunks(4)
                .filter(|p| p[3] == 255 && p[..3] == want)
                .count()
        };
        // The operator's value is styled too (a typed field).
        let data: Data = [("v".to_string(), "<c=#0000ff>MMMM</c>".to_string())].into();
        let f = r.render_template(&project, &t, "main", 5.0, &data);
        assert!(count(&f, [255, 0, 0]) > 500, "the text's own colour");
        assert!(count(&f, [0, 255, 0]) > 500, "the green part");
        assert!(count(&f, [0, 0, 255]) > 500, "the operator's blue part");
    }

    #[test]
    fn table_rows_take_their_colour_from_the_data() {
        let project = sample::demo_project();
        let t: cg_core::Template = serde_json::from_value(serde_json::json!({
            "id": "tt", "name": "T", "duration": 10.0, "markers": [], "fields": [], "zone": "",
            "layers": [{
                "id": "tb", "name": "Table", "type": "table",
                "grid": [["team", "color"], ["A", "#00ff00"], ["B", "#0000ff"]],
                "cols": [{"src": "team", "label": "Team", "pct": 100.0}],
                "title": {"on": false, "text": ""}, "headerRow": false, "showRank": false,
                "cascade": {"on": false}, "rowH": 100.0, "gap": 0.0,
                "rowFrom": "color", "rowPaint": "bg",
                "props": {"x": 0.0, "y": 0.0, "width": 800.0, "height": 400.0}
            }]
        }))
        .unwrap();
        let mut r = Renderer::new(std::env::temp_dir().join("cg-render-test-assets"));
        let f = r.render_template(&project, &t, "main", 5.0, &Default::default());
        let w = f.width as usize;
        let px = |x: usize, y: usize| &f.data[(y * w + x) * 4..(y * w + x) * 4 + 3];
        // Far right of each row (no text there): the row's own colour.
        assert_eq!(px(780, 50), [0, 255, 0], "first row green");
        assert_eq!(px(780, 150), [0, 0, 255], "second row blue");
    }

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
