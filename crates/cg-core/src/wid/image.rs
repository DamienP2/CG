//! Image: fits (incl. original size and tile), focal point, crop, rounded /
//! circle mask, stroke, colorize, fallback picture, animated sequence.
//! The source and the basic fit stay the layer's `src` / `fit` (older
//! projects); `fitMode` adds Original / Tile on top.
//! Drawn by `cg-render/src/wid/image.rs` and `web/src/widgets/image.tsx` (keep in sync).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::ActCtx;
use crate::model::{ImageFit, Layer, LayerKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    /// Picture at its own size, centred.
    Original,
    /// Repeated at `tileScale` %.
    Tile,
}

/// The fit in effect (the layer's `fit` unless `fitMode` is set).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    Contain,
    Cover,
    Stretch,
    Original,
    Tile,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mask {
    #[default]
    None,
    Rounded,
    Circle,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Colorize {
    #[default]
    None,
    /// Every opaque pixel takes the colour (one-colour logos).
    Replace,
    /// Greys take the colour (monochrome pictures).
    Tint,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayMode {
    #[default]
    Loop,
    Once,
    Count,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Start {
    /// Plays from the first frame at every take.
    #[default]
    In,
    /// Waits on the first frame: the operator plays it.
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Focal {
    pub x: f32,
    pub y: f32,
}
impl Default for Focal {
    fn default() -> Self {
        Self { x: 0.5, y: 0.5 }
    }
}

/// Fractions of the picture cut on each side.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Crop {
    pub l: f32,
    pub t: f32,
    pub r: f32,
    pub b: f32,
}

/// Settings of the widget, flattened into the layer. The stroke colour and
/// width are the animated `stroke` / `strokeWidth`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub fit_mode: Option<FitMode>,
    /// Tile: size of a tile, % of the picture.
    pub tile_scale: f32,
    /// Kept in view when Cover crops (fractions of the picture).
    pub focal: Focal,
    pub crop: Crop,
    pub mask: Mask,
    /// Rounded mask radius, px.
    pub radius: f32,
    pub colorize: Colorize,
    pub tint: String,
    /// Shown when the source cannot be found (empty = the built-in slate).
    pub fallback: String,
    /// Animated sequence: asset paths played instead of `src`.
    pub frames: Vec<String>,
    pub fps: f32,
    pub play_mode: PlayMode,
    pub loops: u32,
    pub start: Start,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            fit_mode: None,
            tile_scale: 100.0,
            focal: Focal::default(),
            crop: Crop::default(),
            mask: Mask::None,
            radius: 28.0,
            colorize: Colorize::None,
            tint: "#ff3b5c".into(),
            fallback: String::new(),
            frames: Vec::new(),
            fps: 12.0,
            play_mode: PlayMode::Loop,
            loops: 3,
            start: Start::In,
        }
    }
}

pub fn fit(c: &Config, legacy: ImageFit) -> Fit {
    match (c.fit_mode, legacy) {
        (Some(FitMode::Original), _) => Fit::Original,
        (Some(FitMode::Tile), _) => Fit::Tile,
        (None, ImageFit::Contain) => Fit::Contain,
        (None, ImageFit::Cover) => Fit::Cover,
        (None, ImageFit::Stretch) => Fit::Stretch,
    }
}

/// x, y, w, h.
pub type Rect = [f32; 4];

/// The visible frame in the box and its corner radius (circle = centred
/// circle of the smallest side).
pub fn frame_rect(c: &Config, w: f32, h: f32) -> (Rect, f32) {
    match c.mask {
        Mask::Circle => {
            let d = w.min(h);
            ([(w - d) / 2.0, (h - d) / 2.0, d, d], d / 2.0)
        }
        Mask::Rounded => (
            [0.0, 0.0, w, h],
            c.radius.max(0.0).min(w / 2.0).min(h / 2.0),
        ),
        Mask::None => ([0.0, 0.0, w, h], 0.0),
    }
}

/// The crop, each side capped so that 5 % of the picture is always left.
pub fn crop(c: &Config) -> Crop {
    let k = |v: f32| v.clamp(0.0, 0.95);
    let (l, t) = (k(c.crop.l), k(c.crop.t));
    Crop {
        l,
        t,
        r: c.crop.r.clamp(0.0, (0.95 - l).max(0.0)),
        b: c.crop.b.clamp(0.0, (0.95 - t).max(0.0)),
    }
}

/// Where the (cropped) picture `iw` × `ih` goes in a frame `fw` × `fh`:
/// the visible window and the whole picture, relative to the frame.
pub fn place(
    c: &Config,
    (iw, ih): (f32, f32),
    (fw, fh): (f32, f32),
    fit: Fit,
    cr: Crop,
) -> (Rect, Rect) {
    let (cw, ch) = (iw * (1.0 - cr.l - cr.r), ih * (1.0 - cr.t - cr.b));
    let (cw, ch) = (cw.max(1e-3), ch.max(1e-3));
    let (sx, sy, ox, oy);
    if fit == Fit::Stretch {
        (sx, sy, ox, oy) = (fw / cw, fh / ch, 0.0, 0.0);
    } else {
        let k = match fit {
            Fit::Contain => (fw / cw).min(fh / ch),
            Fit::Cover => (fw / cw).max(fh / ch),
            _ => 1.0,
        };
        let (mut x, mut y) = ((fw - cw * k) / 2.0, (fh - ch * k) / 2.0);
        if fit == Fit::Cover {
            // The focal point goes to the centre, as far as the picture still covers.
            let fx = (c.focal.x - cr.l) * iw * k;
            let fy = (c.focal.y - cr.t) * ih * k;
            // Rounding can make the lower bound a hair above 0: never a reversed range.
            x = (fw / 2.0 - fx).clamp((fw - cw * k).min(0.0), 0.0);
            y = (fh / 2.0 - fy).clamp((fh - ch * k).min(0.0), 0.0);
        }
        (sx, sy, ox, oy) = (k, k, x, y);
    }
    (
        [ox, oy, cw * sx, ch * sy],
        [ox - cr.l * iw * sx, oy - cr.t * ih * sy, iw * sx, ih * sy],
    )
}

/// Operator state of an animated sequence started by hand. Times are wall
/// clock (ms), so playback never drifts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub playing: bool,
    /// When frame 0 would have been shown (playing).
    pub at_ms: i64,
    /// Seconds played when paused.
    pub paused_el: f64,
}

/// Where a sequence is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Seq {
    pub idx: usize,
    /// 1-based loop.
    pub lap: u64,
    /// None = loops forever.
    pub loops: Option<u64>,
    pub ended: bool,
    pub el: f64,
}

pub fn seq(c: &Config, st: &State, now_ms: i64, age_secs: f64) -> Seq {
    let n = c.frames.len().max(1) as u64;
    let el = match c.start {
        Start::In => age_secs,
        Start::Manual if st.playing => (now_ms - st.at_ms) as f64 / 1000.0,
        Start::Manual => st.paused_el,
    }
    .max(0.0);
    let loops = match c.play_mode {
        PlayMode::Loop => None,
        PlayMode::Once => Some(1),
        PlayMode::Count => Some(c.loops.max(1) as u64),
    };
    let mut f = (el * c.fps.clamp(0.1, 120.0) as f64).floor() as u64;
    let mut ended = false;
    if let Some(l) = loops {
        if f >= n * l {
            f = n * l - 1;
            ended = true;
        }
    }
    Seq {
        idx: (f % n) as usize,
        lap: f / n + 1,
        loops,
        ended,
        el,
    }
}

/// Operator actions of a sequence in manual start: `play`, `pause`, `restart`.
pub fn act(
    layer: &Layer,
    st: &mut State,
    op: &str,
    _args: &Value,
    ctx: &ActCtx,
) -> Result<(), String> {
    let LayerKind::Image { x: c, .. } = &layer.kind else {
        return Err("not an image".into());
    };
    let now = ctx.now_ms;
    match op {
        "play" => {
            if st.playing {
                return Ok(());
            }
            let s = seq(c, st, now, 0.0);
            // Finished: plays again from the start.
            let el = if s.ended { 0.0 } else { st.paused_el };
            st.playing = true;
            st.at_ms = now - (el * 1000.0) as i64;
            st.paused_el = el;
        }
        "pause" => {
            if !st.playing {
                return Ok(());
            }
            let s = seq(c, st, now, 0.0);
            let total = c.frames.len().max(1) as f64 / c.fps.clamp(0.1, 120.0) as f64;
            let el = match s.loops {
                Some(l) if s.ended => total * l as f64,
                _ => s.el,
            };
            *st = State {
                playing: false,
                at_ms: 0,
                paused_el: el,
            };
        }
        "restart" => {
            *st = State {
                playing: true,
                at_ms: now,
                paused_el: 0.0,
            };
        }
        _ => return Err(format!("unknown action `{op}`")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anim::Data;

    fn layer(json: &str) -> Layer {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn old_images_load() {
        let l = layer(
            r#"{"id":"a","name":"I","type":"image","props":{},"src":"/assets/a.png","fit":"cover"}"#,
        );
        let LayerKind::Image { x, fit: f, .. } = &l.kind else {
            panic!()
        };
        assert_eq!(*x, Config::default());
        assert_eq!(fit(x, *f), Fit::Cover);
        assert_eq!(frame_rect(x, 100.0, 50.0), ([0.0, 0.0, 100.0, 50.0], 0.0));
    }

    #[test]
    fn cover_keeps_the_focal_point() {
        let c = Config {
            focal: Focal { x: 1.0, y: 0.5 },
            ..Default::default()
        };
        // 200 × 100 picture in a 100 × 100 frame: scale 1, shifted to the right edge.
        let (win, pic) = place(
            &c,
            (200.0, 100.0),
            (100.0, 100.0),
            Fit::Cover,
            Crop::default(),
        );
        assert_eq!(win[0], -100.0);
        assert_eq!(pic[2], 200.0);
        // Contain of another ratio: the frame does not move, the picture fits in it.
        let (win, _) = place(
            &c,
            (400.0, 100.0),
            (100.0, 100.0),
            Fit::Contain,
            Crop::default(),
        );
        assert_eq!(win, [0.0, 37.5, 100.0, 25.0]);
    }

    #[test]
    fn crop_is_capped() {
        let c = Config {
            crop: Crop {
                l: 0.9,
                r: 0.9,
                t: 0.0,
                b: 0.0,
            },
            ..Default::default()
        };
        let k = crop(&c);
        assert!(k.l + k.r <= 0.95 + 1e-6);
    }

    #[test]
    fn sequence_playback() {
        let l = layer(
            r#"{"id":"a","name":"I","type":"image","props":{},"src":"","frames":["a","b","c"],"fps":10,"playMode":"once","start":"manual"}"#,
        );
        let LayerKind::Image { x: c, .. } = &l.kind else {
            panic!()
        };
        let data = Data::default();
        let ctx = |now_ms| ActCtx {
            now_ms,
            age_secs: 0.0,
            data: &data,
        };
        let mut st = State::default();
        assert_eq!(seq(c, &st, 5000, 9.0).idx, 0);
        act(&l, &mut st, "play", &Value::Null, &ctx(1000)).unwrap();
        assert_eq!(seq(c, &st, 1150, 0.0).idx, 1);
        act(&l, &mut st, "pause", &Value::Null, &ctx(1150)).unwrap();
        assert_eq!(seq(c, &st, 99_000, 0.0).idx, 1);
        act(&l, &mut st, "play", &Value::Null, &ctx(2000)).unwrap();
        // Once: stays on the last frame.
        let s = seq(c, &st, 9000, 0.0);
        assert!(s.ended && s.idx == 2);
        act(&l, &mut st, "restart", &Value::Null, &ctx(9000)).unwrap();
        assert_eq!(seq(c, &st, 9000, 0.0).idx, 0);
        assert!(act(&l, &mut st, "jump", &Value::Null, &ctx(0)).is_err());
    }
}
