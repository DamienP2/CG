//! Import of svg files: see [`super`].

use super::{Converted, Ctx};

pub fn analyze(_bytes: &[u8], _ctx: &Ctx) -> Result<Converted, String> {
    Err("not supported yet".into())
}
