//! Ellipse: drawing (same picture as `web/src/widgets/ellipse.tsx`).

use cg_core::wid::ellipse::{outline, State};
use cg_core::wid::shape::FillRule;
use cg_core::{LayerKind, Prop};

use super::{shape, Draw};

pub(crate) fn draw(d: &mut Draw, _st: &State) -> bool {
    let LayerKind::Ellipse { x: c } = &d.layer.kind else {
        return false;
    };
    let Some((cmds, closed)) = outline(c, d.w, d.h) else {
        return true;
    };
    if closed {
        shape::paint(d, &cmds, &c.fill_style, &c.stroke_style, FillRule::Evenodd);
    } else if let Some(p) = shape::path(&cmds) {
        // An arc: its centred stroke only, with its ends.
        let width = d.num(Prop::StrokeWidth).max(1.0);
        let s = shape::stroke_of(&c.stroke_style, width);
        let col = d.color(Prop::Stroke);
        d.stroke(&p, col, &s, None);
    }
    true
}
