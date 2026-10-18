//! Typewriter: drawing (same picture as `web/src/widgets/typewriter.tsx`).

use cg_core::wid::typewriter::State;

use super::Draw;

/// Draws the layer; false = not handled here (the generic code draws it).
pub(crate) fn draw(_d: &mut Draw, _st: &State) -> bool {
    false
}
