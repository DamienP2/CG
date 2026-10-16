//! Playout state machine for an output channel.
//!
//! A channel holds several *playout layers* (z-ordered); each one can carry a
//! graphic on air. Graphics follow the MXMZ model: take in plays until the
//! first pause marker, continue plays to the next one, take out jumps to the
//! out marker and plays to the end before the graphic is removed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::anim::Data;
use crate::model::{Project, Template, ZoneTransition};

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

/// A take waiting for the graphic on air in its zone to finish going out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTake {
    pub template_id: String,
    pub data: Data,
    #[serde(default)]
    pub rundown_id: Option<String>,
    /// First hold frame of the template.
    pub target: f64,
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
    /// Frames spent on air since the take, including holds (drives tickers,
    /// rolls and timers).
    #[serde(default)]
    pub age: f64,
    /// Comes in once this graphic has finished going out (sequential zones).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<QueuedTake>,
}

impl PlayoutItem {
    fn start(q: QueuedTake) -> Self {
        Self {
            template_id: q.template_id,
            data: q.data,
            frame: 0.0,
            target: q.target,
            phase: Phase::Playing,
            rundown_id: q.rundown_id,
            age: 0.0,
            next: None,
        }
    }
}

/// Commands address a zone by id (`zone`) or a raw playout layer (`layer`).
/// A take with neither plays in the template's zone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    Take {
        #[serde(default)]
        zone: Option<String>,
        #[serde(default)]
        layer: Option<u32>,
        template_id: String,
        #[serde(default)]
        data: Option<Data>,
        #[serde(default)]
        rundown_id: Option<String>,
    },
    Continue {
        #[serde(default)]
        zone: Option<String>,
        #[serde(default)]
        layer: Option<u32>,
    },
    TakeOut {
        #[serde(default)]
        zone: Option<String>,
        #[serde(default)]
        layer: Option<u32>,
    },
    Update {
        #[serde(default)]
        zone: Option<String>,
        #[serde(default)]
        layer: Option<u32>,
        data: Data,
    },
    /// Removes the graphic(s) at once; without zone or layer, everything.
    Clear {
        #[serde(default)]
        zone: Option<String>,
        #[serde(default)]
        layer: Option<u32>,
    },
}

impl Command {
    pub fn take(zone: &str, template_id: &str) -> Self {
        Command::Take {
            zone: Some(zone.into()),
            layer: None,
            template_id: template_id.into(),
            data: None,
            rundown_id: None,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PlayoutError {
    #[error("unknown template `{0}`")]
    UnknownTemplate(String),
    #[error("unknown zone `{0}`")]
    UnknownZone(String),
    #[error("say which zone (or layer) to play in")]
    NoZone,
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

fn resolve(
    project: &Project,
    zone: &Option<String>,
    layer: Option<u32>,
) -> Result<Option<u32>, PlayoutError> {
    match zone.as_deref().filter(|z| !z.is_empty()) {
        Some(z) => project
            .zone(z)
            .map(|z| Some(z.layer))
            .ok_or_else(|| PlayoutError::UnknownZone(z.into())),
        None => Ok(layer),
    }
}

/// Starts the out animation; false if the template has none (remove now).
fn begin_out(project: &Project, item: &mut PlayoutItem) -> bool {
    let t = project.template(&item.template_id);
    match t.and_then(|t| t.out_frame().map(|o| (o, t.duration))) {
        Some((out, end)) if end > out => {
            if item.phase != Phase::Out {
                item.frame = item.frame.max(out);
                item.target = end;
                item.phase = Phase::Out;
            }
            true
        }
        _ => false,
    }
}

impl ChannelState {
    pub fn apply(&mut self, project: &Project, cmd: Command) -> Result<(), PlayoutError> {
        match cmd {
            Command::Take {
                zone,
                layer,
                template_id,
                data,
                rundown_id,
            } => {
                let t = project
                    .template(&template_id)
                    .ok_or_else(|| PlayoutError::UnknownTemplate(template_id.clone()))?;
                let layer = match resolve(project, &zone, layer)? {
                    Some(l) => l,
                    None => project
                        .zone(&t.zone)
                        .map(|z| z.layer)
                        .ok_or(PlayoutError::NoZone)?,
                };
                let mut merged = t.default_data();
                merged.extend(data.unwrap_or_default());
                let take = QueuedTake {
                    template_id,
                    data: merged,
                    rundown_id,
                    target: hold_target(t, 0.0),
                };
                let sequential = project
                    .zone_at(layer)
                    .is_none_or(|z| z.transition == ZoneTransition::Sequential);
                match self.layers.get_mut(&layer) {
                    // Zone busy: the graphic on air goes out first.
                    Some(current) if sequential => {
                        if begin_out(project, current) {
                            current.next = Some(take);
                        } else {
                            *current = PlayoutItem::start(take);
                        }
                    }
                    _ => {
                        self.layers.insert(layer, PlayoutItem::start(take));
                    }
                }
            }
            Command::Continue { zone, layer } => {
                let layer = resolve(project, &zone, layer)?.ok_or(PlayoutError::NoZone)?;
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
                // Continue from where we will stop (skip ahead if still moving)
                // to the next pause, or the out marker; nothing ahead: no-op
                // (the "On air" and "Out" points are often the same frame).
                let from = item.target.max(item.frame);
                let next = t
                    .next_pause_after(from)
                    .or_else(|| t.out_frame().filter(|&o| o > from + 1e-6));
                if let Some(next) = next {
                    item.frame = from;
                    item.target = next;
                    item.phase = Phase::Playing;
                }
            }
            Command::TakeOut { zone, layer } => {
                let layer = resolve(project, &zone, layer)?.ok_or(PlayoutError::NoZone)?;
                let item = self
                    .layers
                    .get_mut(&layer)
                    .ok_or(PlayoutError::EmptyLayer(layer))?;
                // Out also cancels a pending take.
                item.next = None;
                if !begin_out(project, item) {
                    self.layers.remove(&layer);
                }
            }
            Command::Update { zone, layer, data } => {
                let layer = resolve(project, &zone, layer)?.ok_or(PlayoutError::NoZone)?;
                let item = self
                    .layers
                    .get_mut(&layer)
                    .ok_or(PlayoutError::EmptyLayer(layer))?;
                // Update what is (about to be) on air.
                match &mut item.next {
                    Some(q) => q.data.extend(data),
                    None => item.data.extend(data),
                }
            }
            Command::Clear { zone, layer } => match resolve(project, &zone, layer)? {
                Some(l) => {
                    self.layers.remove(&l);
                }
                None => self.layers.clear(),
            },
        }
        Ok(())
    }

    /// Advances every item by `frames`. Returns true if a timeline moved
    /// (holding items only age, which clients extrapolate on their own).
    pub fn tick(&mut self, frames: f64) -> bool {
        let mut changed = false;
        let mut finished = Vec::new();
        for (layer, item) in self.layers.iter_mut() {
            item.age += frames;
            if item.phase == Phase::Holding {
                continue;
            }
            changed = true;
            item.frame = (item.frame + frames).min(item.target);
            if item.frame >= item.target {
                if item.phase == Phase::Out {
                    finished.push(*layer);
                } else {
                    item.phase = Phase::Holding;
                }
            }
        }
        for layer in finished {
            if let Some(q) = self.layers.remove(&layer).and_then(|i| i.next) {
                self.layers.insert(layer, PlayoutItem::start(q));
            }
        }
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
            description: String::new(),
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::default(),
            templates: vec![Template {
                logic: Default::default(),
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
                zone: "z".into(),
            }],
            rundown: vec![],
            playlists: vec![],
            formats: vec![],
            zones: vec![crate::model::Zone {
                id: "z".into(),
                name: "Zone".into(),
                layer: 1,
                color: String::new(),
                transition: ZoneTransition::Sequential,
                areas: Default::default(),
            }],
        }
    }

    #[test]
    fn full_cycle() {
        let p = project();
        let mut ch = ChannelState::default();
        ch.apply(
            &p,
            Command::Take {
                zone: None,
                layer: Some(1),
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

        ch.apply(
            &p,
            Command::Continue {
                zone: None,
                layer: Some(1),
            },
        )
        .unwrap();
        for _ in 0..30 {
            ch.tick(1.0);
        }
        assert_eq!(ch.layers[&1].frame, 40.0);

        // No more pauses: continue goes to the out marker and holds.
        ch.apply(
            &p,
            Command::Continue {
                zone: None,
                layer: Some(1),
            },
        )
        .unwrap();
        for _ in 0..50 {
            ch.tick(1.0);
        }
        assert_eq!(
            (ch.layers[&1].frame, ch.layers[&1].phase),
            (80.0, Phase::Holding)
        );

        ch.apply(
            &p,
            Command::TakeOut {
                zone: Some("z".into()),
                layer: None,
            },
        )
        .unwrap();
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
                zone: None,
                layer: Some(0),
                template_id: "x".into(),
                data: None,
                rundown_id: None,
            },
        );
        assert_eq!(r, Err(PlayoutError::UnknownTemplate("x".into())));
    }

    #[test]
    fn sequential_zone_chains_out_then_in() {
        let p = project();
        let mut ch = ChannelState::default();
        let take = |rid: &str| Command::Take {
            zone: None,
            layer: None,
            template_id: "t".into(),
            data: None,
            rundown_id: Some(rid.into()),
        };
        ch.apply(&p, take("a")).unwrap();
        for _ in 0..30 {
            ch.tick(1.0);
        }
        // Second take in the busy zone: "a" goes out, "b" waits.
        ch.apply(&p, take("b")).unwrap();
        let it = &ch.layers[&1];
        assert_eq!((it.phase, it.frame), (Phase::Out, 80.0));
        assert_eq!(it.next.as_ref().unwrap().rundown_id.as_deref(), Some("b"));
        for _ in 0..20 {
            ch.tick(1.0);
        }
        let it = &ch.layers[&1];
        assert_eq!(it.rundown_id.as_deref(), Some("b"));
        assert!(it.next.is_none() && it.frame < 20.0);

        // Cut zones replace at once.
        let mut p = p;
        p.zones[0].transition = ZoneTransition::Cut;
        ch.apply(&p, take("c")).unwrap();
        assert_eq!(ch.layers[&1].rundown_id.as_deref(), Some("c"));
        assert_eq!(ch.layers[&1].frame, 0.0);
    }

    #[test]
    fn migrates_layers_to_zones() {
        let mut p = crate::sample::demo_project();
        p.zones.clear();
        for t in &mut p.templates {
            t.zone.clear();
        }
        for r in &mut p.rundown {
            r.zone.clear();
        }
        assert!(p.ensure_zones());
        assert!(p
            .rundown
            .iter()
            .all(|r| p.zone(&r.zone).map(|z| z.layer) == Some(r.layer)));
        assert!(p.templates.iter().all(|t| p.zone(&t.zone).is_some()));
        assert!(!p.ensure_zones());
    }
}
