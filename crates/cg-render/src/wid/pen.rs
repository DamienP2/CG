//! Pen: drawing (same picture as `web/src/widgets/pen.tsx`).

use cg_core::wid::pen::State;

use super::Draw;

/// Draws the layer; false = not handled here (the generic code draws it).
pub(crate) fn draw(_d: &mut Draw, _st: &State) -> bool {
    false
}
