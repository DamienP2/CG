//! Pen: drawing (same picture as `web/src/widgets/pen.tsx`). tiny-skia has
//! no "visible portion" of a path: the path is flattened to a polyline with
//! lengths (`cg_core::wid::pen::flatten`) and cut there.

use cg_core::wid::pen::{
    flatten, outline, portion, progress, segments, stroke_width, visible, Head, Pt, State,
};
use cg_core::wid::shape::Dash;
use cg_core::{LayerKind, Prop};
use tiny_skia::{LineCap, LineJoin, PathBuilder, Stroke, StrokeDash};

use super::{shape, Draw};

fn poly_path(pts: &[Pt], close: bool) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    let (first, rest) = pts.split_first()?;
    pb.move_to(first[0], first[1]);
    for q in rest {
        pb.line_to(q[0], q[1]);
    }
    if close {
        pb.close();
    }
    pb.finish()
}

pub(crate) fn draw(d: &mut Draw, _st: &State) -> bool {
    let LayerKind::Pen { x: c } = &d.layer.kind else {
        return false;
    };
    let segs = segments(c, d.w, d.h);
    if segs.is_empty() {
        // Empty path or a single point: nothing on air (the inspector warns).
        return true;
    }
    let k = progress(d.frame, d.hold, d.fps, d.time.age_secs);
    let (pa, pb, fill_op) = portion(c, k);
    let cmds = outline(c, d.w, d.h);
    // Fill: closed paths only, fading in as the stroke draws.
    if c.closed && c.fill_on && fill_op > 0.0 {
        if let Some(p) = shape::path(&cmds) {
            let keep = d.opacity;
            d.opacity *= fill_op;
            shape::fill(d, &p, &c.fill_style, shape::rule(c.fill_rule));
            d.opacity = keep;
        }
    }
    let sw = stroke_width(c, d.num(Prop::StrokeWidth), d.w, d.h);
    let poly = flatten(&segs);
    let Some(v) = visible(c, &poly, pa, pb, sw) else {
        return true;
    };
    let color = d.color(Prop::Stroke);
    let mut s = shape::stroke_of(&c.stroke_style, sw);
    if c.stroke_style.dash != Dash::Solid {
        // The pattern stays anchored to the start of the path.
        let arr = match c.stroke_style.dash {
            Dash::Dashed => vec![sw * 3.0, sw * 2.0],
            _ => vec![0.001, sw * 2.0],
        };
        s.dash = StrokeDash::new(arr, v.dash_offset);
    }
    let path = match &v.line {
        None => shape::path(&cmds),
        Some(line) => poly_path(line, false),
    };
    if let Some(p) = path {
        d.stroke(&p, color, &s, None);
    }
    for h in &v.heads {
        match h {
            Head::Fill(pts, w) => {
                if let Some(p) = poly_path(pts, true) {
                    d.fill(&p, color, tiny_skia::FillRule::Winding, None);
                    if *w > 0.0 {
                        let st = Stroke {
                            width: *w,
                            line_join: LineJoin::Round,
                            ..Default::default()
                        };
                        d.stroke(&p, color, &st, None);
                    }
                }
            }
            Head::Line(pts, w, butt) => {
                if let Some(p) = poly_path(pts, false) {
                    let st = Stroke {
                        width: *w,
                        line_join: LineJoin::Round,
                        line_cap: if *butt { LineCap::Butt } else { LineCap::Round },
                        ..Default::default()
                    };
                    d.stroke(&p, color, &st, None);
                }
            }
            Head::Circle(ctr, r) => {
                if let Some(p) = PathBuilder::from_circle(ctr[0], ctr[1], *r) {
                    d.fill(&p, color, tiny_skia::FillRule::Winding, None);
                }
            }
        }
    }
    true
}
