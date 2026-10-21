//! A small painter (rectangles, paths, circles, text by centre line, clips,
//! group opacity) used by the scoreboard and the map, mirrored by
//! `web/src/widgets/scoreboard-paint.tsx` (same primitives as SVG) so the
//! two renderers draw the same picture from the same drawing code.

use cg_core::wid::shape::Cmd;
use cg_core::{Color, TextAlign, VerticalAlign};
use tiny_skia::{
    FillRule, GradientStop, LinearGradient, Mask, Paint, Path, Point, SpreadMode, Stroke,
    StrokeDash, Transform,
};

use crate::wid::Draw;

/// `#rgb`, `#rrggbb[aa]` or `rgba(r, g, b, a)` → colour (transparent when invalid).
pub(crate) fn col(s: &str) -> Color {
    let s = s.trim();
    if let Some(inner) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")) {
        let v: Vec<f32> = inner
            .trim_end_matches(')')
            .split(',')
            .filter_map(|x| x.trim().parse().ok())
            .collect();
        if v.len() >= 3 {
            return Color([
                v[0] / 255.0,
                v[1] / 255.0,
                v[2] / 255.0,
                *v.get(3).unwrap_or(&1.0),
            ]);
        }
        return Color::TRANSPARENT;
    }
    let h = s.trim_start_matches('#');
    if h.len() == 3 {
        let e: String = h.chars().flat_map(|c| [c, c]).collect();
        return Draw::hex(&e);
    }
    Draw::hex(s)
}

/// Luminance 0–1 of a colour.
pub(crate) fn lum(s: &str) -> f32 {
    let c = col(s).0;
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/// Readable ink on a background.
pub(crate) fn ink(bg: &str) -> &'static str {
    if lum(bg) > 0.62 {
        "#0b0d18"
    } else {
        "#ffffff"
    }
}

/// Mix of two colours (`k` = share of `b`).
pub(crate) fn mix(a: Color, b: Color, k: f32) -> Color {
    let (a, b) = (a.0, b.0);
    Color([
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
        a[3] + (b[3] - a[3]) * k,
    ])
}

/// Path commands of a rounded rectangle.
pub(crate) fn rrect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Vec<Cmd> {
    let r = r.max(0.0).min(w / 2.0).min(h / 2.0);
    if r <= 0.01 {
        return vec![
            Cmd::Move(x, y),
            Cmd::Line(x + w, y),
            Cmd::Line(x + w, y + h),
            Cmd::Line(x, y + h),
            Cmd::Close,
        ];
    }
    let k = 0.5523 * r;
    vec![
        Cmd::Move(x + r, y),
        Cmd::Line(x + w - r, y),
        Cmd::Cubic(x + w - r + k, y, x + w, y + r - k, x + w, y + r),
        Cmd::Line(x + w, y + h - r),
        Cmd::Cubic(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h),
        Cmd::Line(x + r, y + h),
        Cmd::Cubic(x + r - k, y + h, x, y + h - r + k, x, y + h - r),
        Cmd::Line(x, y + r),
        Cmd::Cubic(x, y + r - k, x + r - k, y, x + r, y),
        Cmd::Close,
    ]
}

/// Path commands of an ellipse.
pub(crate) fn ellipse(cx: f32, cy: f32, rx: f32, ry: f32) -> Vec<Cmd> {
    let (kx, ky) = (0.5523 * rx, 0.5523 * ry);
    vec![
        Cmd::Move(cx + rx, cy),
        Cmd::Cubic(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
        Cmd::Cubic(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
        Cmd::Cubic(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
        Cmd::Cubic(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
        Cmd::Close,
    ]
}

/// A polyline (closed or not).
pub(crate) fn poly(pts: &[(f32, f32)], close: bool) -> Vec<Cmd> {
    let mut out = Vec::with_capacity(pts.len() + 1);
    for (i, &(x, y)) in pts.iter().enumerate() {
        out.push(if i == 0 {
            Cmd::Move(x, y)
        } else {
            Cmd::Line(x, y)
        });
    }
    if close && !out.is_empty() {
        out.push(Cmd::Close);
    }
    out
}

/// Commands moved by (dx, dy) and scaled by `s` around the origin.
pub(crate) fn tf(cmds: &[Cmd], dx: f32, dy: f32, s: f32) -> Vec<Cmd> {
    cmds.iter()
        .map(|c| match *c {
            Cmd::Move(x, y) => Cmd::Move(dx + x * s, dy + y * s),
            Cmd::Line(x, y) => Cmd::Line(dx + x * s, dy + y * s),
            Cmd::Cubic(a, b, c, d, e, f) => Cmd::Cubic(
                dx + a * s,
                dy + b * s,
                dx + c * s,
                dy + d * s,
                dx + e * s,
                dy + f * s,
            ),
            Cmd::Close => Cmd::Close,
        })
        .collect()
}

pub(crate) fn path(cmds: &[Cmd]) -> Option<Path> {
    crate::wid::shape::path(cmds)
}

/// Text options.
#[derive(Clone, Copy)]
pub(crate) struct T {
    pub size: f32,
    pub weight: u16,
    /// -1 start, 0 middle, 1 end.
    pub anchor: i8,
    /// Letter spacing, px.
    pub ls: f32,
    /// Horizontal / vertical scale around (x, cy).
    pub sx: f32,
    pub sy: f32,
    /// Slant (fake italic), tan of the angle.
    pub skew: f32,
}

impl T {
    pub fn new(size: f32, weight: u16) -> Self {
        T {
            size,
            weight,
            anchor: -1,
            ls: 0.0,
            sx: 1.0,
            sy: 1.0,
            skew: 0.0,
        }
    }
    pub fn mid(mut self) -> Self {
        self.anchor = 0;
        self
    }
    pub fn end(mut self) -> Self {
        self.anchor = 1;
        self
    }
    pub fn ls(mut self, ls: f32) -> Self {
        self.ls = ls;
        self
    }
    pub fn scale(mut self, sx: f32, sy: f32) -> Self {
        self.sx = sx;
        self.sy = sy;
        self
    }
    pub fn skew(mut self, k: f32) -> Self {
        self.skew = k;
        self
    }
}

/// The painter: layer-space drawing with a clip stack and a group opacity.
pub(crate) struct Pt<'x, 'a, 'b> {
    pub d: &'x mut Draw<'a, 'b>,
    /// Measure only (layout pass).
    pub dry: bool,
    pub alpha: f32,
    /// Font family of the texts.
    pub font: String,
    mask: Option<Mask>,
    stack: Vec<Option<Mask>>,
}

impl<'x, 'a, 'b> Pt<'x, 'a, 'b> {
    pub fn new(d: &'x mut Draw<'a, 'b>, dry: bool) -> Self {
        let mask = d.mask.cloned();
        Pt {
            d,
            dry,
            alpha: 1.0,
            font: "Inter".into(),
            mask,
            stack: Vec::new(),
        }
    }

    fn paint(&self, c: Color) -> Paint<'static> {
        crate::paint_for(c, self.d.opacity * self.alpha)
    }

    /// Clips what follows to the path, until `pop`.
    pub fn clip(&mut self, cmds: &[Cmd]) {
        self.stack.push(self.mask.clone());
        if self.dry {
            return;
        }
        let Some(p) = path(cmds) else { return };
        let m = match &self.mask {
            Some(m) => {
                let mut m = m.clone();
                m.intersect_path(&p, FillRule::Winding, true, self.d.tf);
                m
            }
            None => {
                let mut m = Mask::new(self.d.pm.width(), self.d.pm.height()).expect("mask");
                m.fill_path(&p, FillRule::Winding, true, self.d.tf);
                m
            }
        };
        self.mask = Some(m);
    }

    pub fn pop(&mut self) {
        if let Some(m) = self.stack.pop() {
            self.mask = m;
        }
    }

    pub fn fill_c(&mut self, cmds: &[Cmd], c: Color) {
        if self.dry || c.0[3] <= 0.0 {
            return;
        }
        let Some(p) = path(cmds) else { return };
        let paint = self.paint(c);
        self.d
            .pm
            .fill_path(&p, &paint, FillRule::Winding, self.d.tf, self.mask.as_ref());
    }

    pub fn fill(&mut self, cmds: &[Cmd], c: &str) {
        self.fill_c(cmds, col(c));
    }

    /// Fills with a linear gradient from (x1, y1) to (x2, y2) (stops: offset, colour).
    pub fn fill_lin(
        &mut self,
        cmds: &[Cmd],
        p1: (f32, f32),
        p2: (f32, f32),
        stops: &[(f32, Color)],
    ) {
        if self.dry {
            return;
        }
        let Some(p) = path(cmds) else { return };
        let a = self.d.opacity * self.alpha;
        let st: Vec<GradientStop> = stops
            .iter()
            .map(|&(o, c)| {
                let [r, g, b, al] = c.0;
                GradientStop::new(
                    o,
                    tiny_skia::Color::from_rgba(
                        r.clamp(0.0, 1.0),
                        g.clamp(0.0, 1.0),
                        b.clamp(0.0, 1.0),
                        (al * a).clamp(0.0, 1.0),
                    )
                    .unwrap_or(tiny_skia::Color::TRANSPARENT),
                )
            })
            .collect();
        let Some(shader) = LinearGradient::new(
            Point::from_xy(p1.0, p1.1),
            Point::from_xy(p2.0, p2.1),
            st,
            SpreadMode::Pad,
            Transform::identity(),
        ) else {
            if let Some(&(_, c)) = stops.first() {
                self.fill_c(cmds, c);
            }
            return;
        };
        let paint = Paint {
            shader,
            anti_alias: true,
            ..Default::default()
        };
        self.d
            .pm
            .fill_path(&p, &paint, FillRule::Winding, self.d.tf, self.mask.as_ref());
    }

    /// Strokes the path (`dash`: on / off lengths; `round`: round caps and joins).
    pub fn stroke_c(
        &mut self,
        cmds: &[Cmd],
        c: Color,
        width: f32,
        round: bool,
        dash: Option<(f32, f32)>,
    ) {
        if self.dry || width <= 0.0 || c.0[3] <= 0.0 {
            return;
        }
        let Some(p) = path(cmds) else { return };
        let mut s = Stroke {
            width,
            ..Default::default()
        };
        if round {
            s.line_cap = tiny_skia::LineCap::Round;
            s.line_join = tiny_skia::LineJoin::Round;
        }
        if let Some((on, off)) = dash {
            s.dash = StrokeDash::new(vec![on, off], 0.0);
        }
        let paint = self.paint(c);
        self.d
            .pm
            .stroke_path(&p, &paint, &s, self.d.tf, self.mask.as_ref());
    }

    pub fn stroke(&mut self, cmds: &[Cmd], c: &str, width: f32, round: bool) {
        self.stroke_c(cmds, col(c), width, round, None);
    }

    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, c: &str) {
        if w > 0.0 && h > 0.0 {
            self.fill(&rrect(x, y, w, h, r), c);
        }
    }

    pub fn rect_c(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, c: Color) {
        if w > 0.0 && h > 0.0 {
            self.fill_c(&rrect(x, y, w, h, r), c);
        }
    }

    pub fn circle(&mut self, cx: f32, cy: f32, r: f32, c: &str) {
        if r > 0.0 {
            self.fill(&ellipse(cx, cy, r, r), c);
        }
    }

    /// Width of a line of text.
    pub fn tw(&mut self, s: &str, size: f32, weight: u16, ls: f32) -> f32 {
        let family = self.font.clone();
        match self.d.font(&family, weight) {
            Some(f) => Draw::text_width(&f, s, size, ls),
            None => s.chars().count() as f32 * size * 0.55,
        }
    }

    fn text_path(&mut self, s: &str, x: f32, cy: f32, o: T) -> Option<Path> {
        let family = self.font.clone();
        let f = self.d.font(&family, o.weight)?;
        let w = Draw::text_width(&f, s, o.size, o.ls);
        let x0 = x - w * (o.anchor as f32 + 1.0) / 2.0;
        let p = Draw::text_path(
            &f,
            s,
            o.size,
            o.ls,
            TextAlign::Left,
            VerticalAlign::Middle,
            (x0, cy - o.size, w.max(1.0) + 4.0, o.size * 2.0),
            crate::text::LINE_HEIGHT,
        )?;
        if o.sx == 1.0 && o.sy == 1.0 && o.skew == 0.0 {
            return Some(p);
        }
        let t = Transform::from_translate(x, cy)
            .pre_concat(Transform::from_row(
                o.sx,
                0.0,
                -o.skew * o.sx,
                o.sy,
                0.0,
                0.0,
            ))
            .pre_translate(-x, -cy);
        p.transform(t)
    }

    /// Text centred vertically on `cy`, anchored at `x`.
    pub fn text(&mut self, s: &str, x: f32, cy: f32, c: &str, o: T) {
        self.text_c(s, x, cy, col(c), o);
    }

    pub fn text_c(&mut self, s: &str, x: f32, cy: f32, c: Color, o: T) {
        if self.dry || s.is_empty() || c.0[3] <= 0.0 || o.sy.abs() < 0.01 {
            return;
        }
        let Some(p) = self.text_path(s, x, cy, o) else {
            return;
        };
        let paint = self.paint(c);
        self.d
            .pm
            .fill_path(&p, &paint, FillRule::Winding, self.d.tf, self.mask.as_ref());
    }

    /// Text with a halo (outline under the fill).
    #[allow(clippy::too_many_arguments)]
    pub fn text_halo(&mut self, s: &str, x: f32, cy: f32, c: Color, halo: Color, hw: f32, o: T) {
        if self.dry || s.is_empty() {
            return;
        }
        let Some(p) = self.text_path(s, x, cy, o) else {
            return;
        };
        let st = Stroke {
            width: hw,
            line_join: tiny_skia::LineJoin::Round,
            ..Default::default()
        };
        let hp = self.paint(halo);
        self.d
            .pm
            .stroke_path(&p, &hp, &st, self.d.tf, self.mask.as_ref());
        let paint = self.paint(c);
        self.d
            .pm
            .fill_path(&p, &paint, FillRule::Winding, self.d.tf, self.mask.as_ref());
    }

    /// A picture fitted (contain) in the box.
    pub fn image(&mut self, src: &str, x: f32, y: f32, w: f32, h: f32) -> bool {
        if self.dry {
            return true;
        }
        let Some((iw, ih)) = self.d.image_size(src) else {
            return false;
        };
        let s = (w / iw as f32).min(h / ih as f32);
        let t =
            Transform::from_translate(x + (w - iw as f32 * s) / 2.0, y + (h - ih as f32 * s) / 2.0)
                .pre_scale(s, s);
        let a = self.alpha;
        let m = self.mask.clone();
        self.d.image(src, t, a, m.as_ref()).is_some()
    }
}
