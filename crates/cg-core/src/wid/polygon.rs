//! Polygon: regular (with a star option), triangle presets, or a free
//! polygon whose vertices are stored as fractions of the box (they scale
//! with it). Drawn by `cg-render/src/wid/polygon.rs` and
//! `web/src/widgets/polygon.tsx` (keep in sync).

use serde::{Deserialize, Serialize};

use super::shape::{rounded_polygon, Cmd, FillRule, FillStyle, StrokeStyle};
use super::ActCtx;
use crate::model::Layer;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Regular,
    Triangle,
    Free,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tri {
    #[default]
    Equilateral,
    Isosceles,
    Right,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dir {
    #[default]
    Up,
    Down,
    Left,
    Right,
}

/// Settings of the widget, flattened into the layer's JSON. Colours and
/// stroke width are the animated `fill`, `stroke` and `strokeWidth`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub mode: Mode,
    /// Regular: number of sides (3…64).
    pub sides: f32,
    /// Degrees; 0 = first vertex at the top.
    pub start_angle: f32,
    pub star: bool,
    /// Star: inner radius, % of the outer one (1…100).
    pub inner: f32,
    pub tri: Tri,
    pub tri_dir: Dir,
    /// Free polygon: vertices as fractions of the box.
    pub verts: Vec<[f32; 2]>,
    /// Free polygon: a click on the stage adds a vertex.
    pub click_add: bool,
    /// Rounding of the vertices, px (capped per vertex).
    pub round: f32,
    /// Fill rule of a free polygon that crosses itself.
    pub fill_rule: FillRule,
    pub fill_style: FillStyle,
    pub stroke_style: StrokeStyle,
}

pub fn free_default() -> Vec<[f32; 2]> {
    vec![
        [0.04, 0.12],
        [0.68, 0.02],
        [0.98, 0.5],
        [0.68, 0.98],
        [0.04, 0.88],
        [0.24, 0.5],
    ]
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::Regular,
            sides: 6.0,
            start_angle: 0.0,
            star: false,
            inner: 50.0,
            tri: Tri::Equilateral,
            tri_dir: Dir::Up,
            verts: free_default(),
            click_add: true,
            round: 0.0,
            fill_rule: FillRule::Nonzero,
            fill_style: FillStyle::default(),
            stroke_style: StrokeStyle::default(),
        }
    }
}

/// Regular polygon or star inscribed in the box's ellipse.
pub fn regular_points(c: &Config, w: f32, h: f32) -> Vec<[f32; 2]> {
    let n = (c.sides.round() as i32).clamp(3, 64) as usize;
    let count = if c.star { n * 2 } else { n };
    let inner = c.inner.clamp(1.0, 100.0) / 100.0;
    (0..count)
        .map(|i| {
            let a = (c.start_angle + i as f32 * 360.0 / count as f32).to_radians();
            let r = if c.star && i % 2 == 1 { inner } else { 1.0 };
            [
                w / 2.0 + a.sin() * r * w / 2.0,
                h / 2.0 - a.cos() * r * h / 2.0,
            ]
        })
        .collect()
}

/// Triangle presets, turned to their direction. The equilateral one keeps
/// its true proportions (the largest that fits the box, centred).
pub fn triangle_points(c: &Config, w: f32, h: f32) -> Vec<[f32; 2]> {
    let side = matches!(c.tri_dir, Dir::Left | Dir::Right);
    let unit: [[f32; 2]; 3] = match c.tri {
        Tri::Right => [[0.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
        _ => [[0.5, 0.0], [1.0, 1.0], [0.0, 1.0]],
    };
    let turn = |[u, v]: [f32; 2]| match c.tri_dir {
        Dir::Down => [u, 1.0 - v],
        Dir::Left => [v, u],
        Dir::Right => [1.0 - v, u],
        Dir::Up => [u, v],
    };
    let (mut fw, mut fh, mut ox, mut oy) = (w, h, 0.0, 0.0);
    if c.tri == Tri::Equilateral {
        let (along, across) = if side { (h, w) } else { (w, h) };
        let len = along.min(across * 2.0 / 3f32.sqrt());
        let th = len * 3f32.sqrt() / 2.0;
        (fw, fh) = if side { (th, len) } else { (len, th) };
        ox = (w - fw) / 2.0;
        oy = (h - fh) / 2.0;
    }
    unit.iter()
        .map(|&p| {
            let [u, v] = turn(p);
            [ox + u * fw, oy + v * fh]
        })
        .collect()
}

/// The vertices in layer pixels.
pub fn points(c: &Config, w: f32, h: f32) -> Vec<[f32; 2]> {
    match c.mode {
        Mode::Regular => regular_points(c, w, h),
        Mode::Triangle => triangle_points(c, w, h),
        Mode::Free => c.verts.iter().map(|[x, y]| [x * w, y * h]).collect(),
    }
}

/// The outline (rounded vertices, each capped to what fits).
pub fn outline(c: &Config, w: f32, h: f32) -> Vec<Cmd> {
    let pts = points(c, w, h);
    if pts.len() < 3 {
        return Vec::new();
    }
    rounded_polygon(&pts, &[c.round])
}

/// Fill rule used: the chosen one for a free polygon, non-zero otherwise.
pub fn rule(c: &Config) -> FillRule {
    if c.mode == Mode::Free {
        c.fill_rule
    } else {
        FillRule::Nonzero
    }
}

/// No operator state: a polygon is taken and taken out like any graphic.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {}

pub fn act(
    _layer: &Layer,
    _st: &mut State,
    op: &str,
    _args: &serde_json::Value,
    _ctx: &ActCtx,
) -> Result<(), String> {
    Err(format!("unknown action `{op}`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_and_star() {
        let c = Config::default();
        let p = regular_points(&c, 200.0, 200.0);
        assert_eq!(p.len(), 6);
        assert!((p[0][0] - 100.0).abs() < 1e-3 && p[0][1].abs() < 1e-3);
        let c = Config {
            star: true,
            sides: 100.0,
            ..Default::default()
        };
        // Sides capped at 64, star = twice the points.
        assert_eq!(regular_points(&c, 200.0, 200.0).len(), 128);
    }

    #[test]
    fn equilateral_keeps_proportions() {
        let c = Config {
            mode: Mode::Triangle,
            ..Default::default()
        };
        let p = triangle_points(&c, 1000.0, 200.0);
        let side = (p[1][0] - p[2][0]).abs();
        let height = p[1][1] - p[0][1];
        assert!((height - side * 3f32.sqrt() / 2.0).abs() < 1e-2);
        assert!((height - 200.0).abs() < 1e-2);
    }

    #[test]
    fn free_vertices_scale_and_overlap() {
        let c = Config {
            mode: Mode::Free,
            round: 30.0,
            verts: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [1.0, 1.0], [0.0, 1.0]],
            ..Default::default()
        };
        assert_eq!(points(&c, 400.0, 100.0)[2], [400.0, 100.0]);
        // Overlapping vertices: still a valid outline, finite numbers only.
        let o = outline(&c, 400.0, 100.0);
        for cmd in o {
            if let Cmd::Line(x, y) | Cmd::Move(x, y) = cmd {
                assert!(x.is_finite() && y.is_finite());
            }
        }
    }

    #[test]
    fn old_and_new_json_load() {
        let l: Layer =
            serde_json::from_str(r#"{"id":"a","name":"P","type":"polygon","props":{}}"#).unwrap();
        let crate::LayerKind::Polygon { x } = l.kind else {
            panic!()
        };
        assert_eq!(x, Config::default());
        let l: Layer = serde_json::from_str(
            r#"{"id":"a","name":"P","type":"polygon","props":{},"mode":"free","fillRule":"evenodd","verts":[[0,0],[1,0],[0.5,1]]}"#,
        )
        .unwrap();
        let crate::LayerKind::Polygon { x } = l.kind else {
            panic!()
        };
        assert_eq!(rule(&x), FillRule::Evenodd);
        assert_eq!(x.verts.len(), 3);
    }
}
