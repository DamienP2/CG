//! Playout state machine for an output channel.
//!
//! A channel holds several *playout layers* (z-ordered); each one can carry a
//! graphic on air. Graphics follow the MXMZ model: take in plays until the
//! first pause marker, continue plays to the next one, take out jumps to the
//! out marker and plays to the end before the graphic is removed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::anim::Data;
use crate::model::{Project, Template};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Moving toward `target`.
    Playing,
    /// Holding on a pause marker (or the out marker), on air.
    Holding,
    /// Playing the out animation; removed when it reaches the end.
    Out,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayoutItem {
    pub template_id: String,
    pub data: Data,
    pub frame: f64,
    pub target: f64,
    pub phase: Phase,
    /// Rundown item that triggered it, if any (for operator tally).
    #[serde(default)]
    pub rundown_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    Take {
        layer: u32,
        template_id: String,
        #[serde(default)]
        data: Option<Data>,
        #[serde(default)]
        rundown_id: Option<String>,
    },
    Continue {
        layer: u32,
    },
    TakeOut {
        layer: u32,
    },
    Update {
        layer: u32,
        data: Data,
    },
    Clear {
        layer: Option<u32>,
    },
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PlayoutError {
    #[error("unknown template `{0}`")]
    UnknownTemplate(String),
    #[error("nothing on air on layer {0}")]
    EmptyLayer(u32),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelState {
    pub layers: BTreeMap<u32, PlayoutItem>,
}

fn hold_target(template: &Template, from: f64) -> f64 {
    template
        .next_pause_after(from)
        .or_else(|| template.out_frame().filter(|&o| o > from + 1e-6))
        .unwrap_or(template.duration)
}

impl ChannelState {
    pub fn apply(&mut self, project: &Project, cmd: Command) -> Result<(), PlayoutError> {
        match cmd {
            Command::Take {
                layer,
                template_id,
                data,
                rundown_id,
            } => {
                let t = project
                    .template(&template_id)
                    .ok_or_else(|| PlayoutError::UnknownTemplate(template_id.clone()))?;
                let mut merged = t.default_data();
                merged.extend(data.unwrap_or_default());
                self.layers.insert(
                    layer,
                    PlayoutItem {
                        template_id,
                        data: merged,
                        frame: 0.0,
                        target: hold_target(t, 0.0),
                        phase: Phase::Playing,
                        rundown_id,
                    },
                );
            }
            Command::Continue { layer } => {
                let item = self
                    .layers
                    .get_mut(&layer)
                    .ok_or(PlayoutError::EmptyLayer(layer))?;
                if item.phase == Phase::Out {
                    return Ok(());
                }
                let t = project
                    .template(&item.template_id)
                    .ok_or_else(|| PlayoutError::UnknownTemplate(item.template_id.clone()))?;
                // Continue from where we will stop (skip ahead if still moving).
                let from = item.target.max(item.frame);
                let next = hold_target(t, from);
                if next > from {
                    item.frame = from;
                    item.target = next;
                    item.phase = Phase::Playing;
                }
            }
            Command::TakeOut { layer } => {
                let item = self
                    .layers
                    .get_mut(&layer)
                    .ok_or(PlayoutError::EmptyLayer(layer))?;
                let t = project.template(&item.template_id);
                match t.and_then(|t| t.out_frame().map(|o| (o, t.duration))) {
                    Some((out, end)) if end > out => {
                        item.frame = item.frame.max(out);
                        item.target = end;
                        item.phase = Phase::Out;
                    }
                    _ => {
                        self.layers.remove(&layer);
                    }
                }
            }
            Command::Update { layer, data } => {
                let item = self
                    .layers
                    .get_mut(&layer)
                    .ok_or(PlayoutError::EmptyLayer(layer))?;
                item.data.extend(data);
            }
            Command::Clear { layer: Some(l) } => {
                self.layers.remove(&l);
            }
            Command::Clear { layer: None } => self.layers.clear(),
        }
        Ok(())
    }

    /// Advances every playing item by `frames`. Returns true if anything changed.
    pub fn tick(&mut self, frames: f64) -> bool {
        let mut changed = false;
        self.layers.retain(|_, item| {
            if item.phase == Phase::Holding {
                return true;
            }
            changed = true;
            item.frame = (item.frame + frames).min(item.target);
            if item.frame >= item.target {
                if item.phase == Phase::Out {
                    return false;
                }
                item.phase = Phase::Holding;
            }
            true
        });
        changed
    }

    pub fn is_animating(&self) -> bool {
        self.layers.values().any(|i| i.phase != Phase::Holding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FrameRate, Marker, MarkerKind};

    fn project() -> Project {
        Project {
            id: "p".into(),
            name: "p".into(),
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::default(),
            templates: vec![Template {
                id: "t".into(),
                name: "t".into(),
                duration: 100.0,
                markers: vec![
                    Marker {
                        id: "a".into(),
                        frame: 20.0,
                        name: "in".into(),
                        kind: MarkerKind::Pause,
                    },
                    Marker {
                        id: "b".into(),
                        frame: 40.0,
                        name: "step".into(),
                        kind: MarkerKind::Pause,
                    },
                    Marker {
                        id: "c".into(),
                        frame: 80.0,
                        name: "out".into(),
                        kind: MarkerKind::Out,
                    },
                ],
                fields: vec![],
                layers: vec![],
            }],
            rundown: vec![],
        }
    }

    #[test]
    fn full_cycle() {
        let p = project();
        let mut ch = ChannelState::default();
        ch.apply(
            &p,
            Command::Take {
                layer: 1,
                template_id: "t".into(),
                data: None,
                rundown_id: None,
            },
        )
        .unwrap();
        for _ in 0..30 {
            ch.tick(1.0);
        }
        let it = &ch.layers[&1];
        assert_eq!((it.frame, it.phase), (20.0, Phase::Holding));

        ch.apply(&p, Command::Continue { layer: 1 }).unwrap();
        for _ in 0..30 {
            ch.tick(1.0);
        }
        assert_eq!(ch.layers[&1].frame, 40.0);

        // No more pauses: continue goes to the out marker and holds.
        ch.apply(&p, Command::Continue { layer: 1 }).unwrap();
        for _ in 0..50 {
            ch.tick(1.0);
        }
        assert_eq!(
            (ch.layers[&1].frame, ch.layers[&1].phase),
            (80.0, Phase::Holding)
        );

        ch.apply(&p, Command::TakeOut { layer: 1 }).unwrap();
        for _ in 0..30 {
            ch.tick(1.0);
        }
        assert!(ch.layers.is_empty());
    }

    #[test]
    fn unknown_template() {
        let mut ch = ChannelState::default();
        let r = ch.apply(
            &project(),
            Command::Take {
                layer: 0,
                template_id: "x".into(),
                data: None,
                rundown_id: None,
            },
        );
        assert_eq!(r, Err(PlayoutError::UnknownTemplate("x".into())));
    }
}
