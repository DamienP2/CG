//! Playout state machine for an output channel.
//!
//! A channel holds several *playout layers* (z-ordered); each one can carry a
//! graphic on air. Take in plays to the on-air marker, stopping at the pause
//! markers on the way; take out plays from the on-air marker to the end,
//! stopping at the pauses after it, before the graphic is removed. A pause
//! resumes on Continue, after its delay, or on its trigger.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::anim::Data;
use crate::model::{Layer, LayerKind, Project, Resume, Template, ZoneTransition};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Moving toward `target`.
    Playing,
    /// Holding on a pause or on the on-air marker.
    Holding,
    /// Playing the out animation; removed when it reaches the end.
    Out,
    /// Holding on a pause of the out animation.
    OutHold,
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
    /// Widgets started, paused or reset by the operator, by layer id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub clocks: BTreeMap<String, LayerClock>,
    /// Frames spent holding at the current stop (timed pauses).
    #[serde(default)]
    pub held: f64,
    /// Out animation: `target` is a pause, not the end.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pause_ahead: bool,
}

/// Own time of a widget layer (timer, ticker, roll…), in frames on air.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerClock {
    /// Subtracted from the item's age.
    #[serde(default)]
    pub offset: f64,
    /// Age at which the widget was paused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<f64>,
}

/// What the operator does to a widget's internal animation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WidgetControl {
    /// Runs (resumes where it was paused).
    Start,
    Pause,
    /// Start when paused, pause when running.
    Toggle,
    /// Back to zero, keeping it running or paused.
    Reset,
    /// Back to zero and running.
    Restart,
}

/// Widgets whose animation follows the time on air.
pub fn is_timed(kind: &LayerKind) -> bool {
    match kind {
        LayerKind::Clock { mode, .. } => {
            matches!(
                mode,
                crate::model::ClockMode::Elapsed | crate::model::ClockMode::Timer
            )
        }
        LayerKind::Text { scroll, .. } => !scroll.is_none(),
        LayerKind::Ticker { .. }
        | LayerKind::Roll { .. }
        | LayerKind::Counter { .. }
        | LayerKind::Progress { .. }
        | LayerKind::Rotator { .. }
        | LayerKind::Typewriter { .. }
        | LayerKind::Slideshow { .. }
        | LayerKind::BarChart { .. } => true,
        _ => false,
    }
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
            clocks: BTreeMap::new(),
            held: 0.0,
            pause_ahead: false,
        }
    }

    /// Time on air of one layer, in frames: the item's age, unless the
    /// operator paused, reset or has yet to start (manual start) the widget.
    pub fn layer_age(&self, layer: &Layer) -> f64 {
        match self.clocks.get(&layer.id) {
            Some(c) => (c.paused_at.unwrap_or(self.age) - c.offset).max(0.0),
            None if layer.manual_start => 0.0,
            None => self.age,
        }
    }

    fn control(&mut self, layer: &Layer, control: WidgetControl) {
        let age = self.age;
        let c = self
            .clocks
            .entry(layer.id.clone())
            .or_insert(if layer.manual_start {
                LayerClock {
                    offset: age,
                    paused_at: Some(age),
                }
            } else {
                LayerClock::default()
            });
        let running = c.paused_at.is_none();
        match control {
            WidgetControl::Start => {
                if let Some(p) = c.paused_at.take() {
                    c.offset += age - p;
                }
            }
            WidgetControl::Pause => {
                c.paused_at.get_or_insert(age);
            }
            WidgetControl::Toggle => {
                if running {
                    c.paused_at = Some(age);
                } else if let Some(p) = c.paused_at.take() {
                    c.offset += age - p;
                }
            }
            WidgetControl::Reset => {
                c.offset = age;
                if !running {
                    c.paused_at = Some(age);
                }
            }
            WidgetControl::Restart => {
                c.offset = age;
                c.paused_at = None;
            }
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
    /// Starts, pauses or resets the internal animation of widgets (timer,
    /// stopwatch, ticker, roll, counter…) of the graphic on air. `target` is
    /// a layer id or name; `*` means every timed widget of the graphic.
    #[serde(rename_all = "camelCase")]
    Widget {
        #[serde(default)]
        zone: Option<String>,
        #[serde(default)]
        layer: Option<u32>,
        target: String,
        control: WidgetControl,
    },
    /// Resumes every graphic holding on a pause that waits for this trigger.
    Trigger { name: String },
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
    #[error("no timed widget `{0}` in the graphic on air")]
    UnknownWidget(String),
    #[error("nothing on air on layer {0}")]
    EmptyLayer(u32),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelState {
    pub layers: BTreeMap<u32, PlayoutItem>,
}

fn hold_target(template: &Template, from: f64) -> f64 {
    template.next_stop_after(from)
}

/// Plays on from the stop the item holds at (or is heading to). Holding on
/// air waits for Take out; nothing happens while the out animation moves.
fn resume(t: &Template, item: &mut PlayoutItem) -> bool {
    match item.phase {
        Phase::Out => false,
        Phase::OutHold => {
            item.target = t.next_stop_after(item.frame);
            item.pause_ahead = item.target < t.duration - 1e-6;
            item.phase = Phase::Out;
            item.held = 0.0;
            true
        }
        Phase::Playing | Phase::Holding => {
            let from = item.target.max(item.frame);
            if from >= t.hold_frame() - 1e-6 {
                return false;
            }
            item.frame = from;
            item.target = t.next_stop_after(from).min(t.hold_frame());
            item.phase = Phase::Playing;
            item.held = 0.0;
            true
        }
    }
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
    let Some(t) = project.template(&item.template_id) else {
        return false;
    };
    let out = t.hold_frame();
    if t.duration <= out + 1e-6 {
        return false;
    }
    if matches!(item.phase, Phase::Out | Phase::OutHold) {
        // Out again: straight to the end, through the pauses.
        item.target = t.duration;
    } else {
        item.frame = item.frame.max(out);
        item.target = t.next_stop_after(item.frame);
    }
    item.pause_ahead = item.target < t.duration - 1e-6;
    item.phase = Phase::Out;
    item.held = 0.0;
    true
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
                let t = project
                    .template(&item.template_id)
                    .ok_or_else(|| PlayoutError::UnknownTemplate(item.template_id.clone()))?;
                resume(t, item);
            }
            Command::Trigger { name } => {
                for item in self.layers.values_mut() {
                    if !matches!(item.phase, Phase::Holding | Phase::OutHold) {
                        continue;
                    }
                    let Some(t) = project.template(&item.template_id) else {
                        continue;
                    };
                    let waits = t.pause_at(item.frame).is_some_and(|m| {
                        matches!(&m.resume, Resume::Trigger { name: n } if n.trim().eq_ignore_ascii_case(name.trim()))
                    });
                    if waits {
                        resume(t, item);
                    }
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
            Command::Widget {
                zone,
                layer,
                target,
                control,
            } => {
                let layer = resolve(project, &zone, layer)?.ok_or(PlayoutError::NoZone)?;
                let item = self
                    .layers
                    .get_mut(&layer)
                    .ok_or(PlayoutError::EmptyLayer(layer))?;
                let t = project
                    .template(&item.template_id)
                    .ok_or_else(|| PlayoutError::UnknownTemplate(item.template_id.clone()))?;
                let all = target == "*";
                let targets: Vec<&Layer> = t
                    .layers
                    .iter()
                    .filter(|l| {
                        is_timed(&l.kind)
                            && (all || l.id == target || l.name.eq_ignore_ascii_case(target.trim()))
                    })
                    .collect();
                if targets.is_empty() {
                    return Err(PlayoutError::UnknownWidget(target));
                }
                for l in targets {
                    item.control(l, control);
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
            if matches!(item.phase, Phase::Holding | Phase::OutHold) {
                item.held += frames;
                continue;
            }
            changed = true;
            item.frame = (item.frame + frames).min(item.target);
            if item.frame >= item.target {
                item.held = 0.0;
                if item.phase == Phase::Out {
                    // A pause of the out animation stops it before the end.
                    if item.pause_ahead {
                        item.phase = Phase::OutHold;
                    } else {
                        finished.push(*layer);
                    }
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

    /// Resumes the pauses whose delay is over. `fps`: project frame rate.
    pub fn auto_resume(&mut self, project: &Project) -> bool {
        let fps = project.frame_rate.as_f64().max(1.0);
        let mut changed = false;
        for item in self.layers.values_mut() {
            if !matches!(item.phase, Phase::Holding | Phase::OutHold) {
                continue;
            }
            let Some(t) = project.template(&item.template_id) else {
                continue;
            };
            let due = t
                .pause_at(item.frame)
                .is_some_and(|m| matches!(m.resume, Resume::After { seconds } if item.held >= seconds.max(0.0) * fps));
            if due {
                changed |= resume(t, item);
            }
        }
        changed
    }

    pub fn is_animating(&self) -> bool {
        self.layers
            .values()
            .any(|i| !matches!(i.phase, Phase::Holding | Phase::OutHold))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Resume;
    use crate::model::{FrameRate, Marker, MarkerKind};

    fn project() -> Project {
        Project {
            guides: Default::default(),
            id: "p".into(),
            name: "p".into(),
            description: String::new(),
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::default(),
            templates: vec![Template {
                logic: Default::default(),
                revision: 0,
                marker_model: crate::model::MARKER_MODEL,
                id: "t".into(),
                name: "t".into(),
                duration: 100.0,
                markers: vec![
                    Marker {
                        id: "a".into(),
                        frame: 20.0,
                        name: "in".into(),
                        kind: MarkerKind::Pause,
                        resume: Default::default(),
                    },
                    Marker {
                        id: "b".into(),
                        frame: 40.0,
                        name: "step".into(),
                        kind: MarkerKind::Pause,
                        resume: Default::default(),
                    },
                    Marker {
                        id: "c".into(),
                        frame: 80.0,
                        name: "out".into(),
                        kind: MarkerKind::Out,
                        resume: Default::default(),
                    },
                ],
                fields: vec![],
                layers: vec![],
                zone: "z".into(),
            }],
            rundown: vec![],
            playlists: vec![],
            formats: vec![],
            drafts: vec![],
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

    fn take(ch: &mut ChannelState, p: &Project) {
        ch.apply(
            p,
            Command::Take {
                zone: None,
                layer: Some(1),
                template_id: "t".into(),
                data: None,
                rundown_id: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn timed_and_triggered_pauses() {
        let mut p = project();
        let t = &mut p.templates[0];
        t.markers[0].resume = Resume::After { seconds: 0.5 };
        t.markers[1].resume = Resume::Trigger {
            name: "Goal".into(),
        };
        let fps = p.frame_rate.as_f64();
        let mut ch = ChannelState::default();
        take(&mut ch, &p);
        for _ in 0..20 {
            ch.tick(1.0);
        }
        assert_eq!(
            (ch.layers[&1].frame, ch.layers[&1].phase),
            (20.0, Phase::Holding)
        );
        // Resumes by itself after half a second.
        for _ in 0..(fps * 0.5) as usize + 1 {
            ch.tick(1.0);
            ch.auto_resume(&p);
        }
        for _ in 0..25 {
            ch.tick(1.0);
            ch.auto_resume(&p);
        }
        assert_eq!(
            (ch.layers[&1].frame, ch.layers[&1].phase),
            (40.0, Phase::Holding)
        );
        // Waits for its trigger, whatever the delay.
        ch.apply(
            &p,
            Command::Trigger {
                name: "other".into(),
            },
        )
        .unwrap();
        ch.tick(1.0);
        assert_eq!(ch.layers[&1].frame, 40.0);
        ch.apply(
            &p,
            Command::Trigger {
                name: "goal".into(),
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
    }

    #[test]
    fn pauses_in_the_out_animation() {
        let mut p = project();
        p.templates[0].markers.push(Marker {
            id: "d".into(),
            frame: 90.0,
            name: "Pause".into(),
            kind: MarkerKind::Pause,
            resume: Resume::Manual,
        });
        let mut ch = ChannelState::default();
        take(&mut ch, &p);
        let cont = Command::Continue {
            zone: None,
            layer: Some(1),
        };
        for _ in 0..3 {
            for _ in 0..50 {
                ch.tick(1.0);
            }
            ch.apply(&p, cont.clone()).unwrap();
        }
        assert_eq!(ch.layers[&1].frame, 80.0);
        ch.apply(
            &p,
            Command::TakeOut {
                zone: None,
                layer: Some(1),
            },
        )
        .unwrap();
        for _ in 0..30 {
            ch.tick(1.0);
        }
        assert_eq!(
            (ch.layers[&1].frame, ch.layers[&1].phase),
            (90.0, Phase::OutHold)
        );
        ch.apply(&p, cont).unwrap();
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

    #[test]
    fn widget_clocks() {
        let mut p = crate::sample::demo_project();
        let ticker = p.template("ticker").unwrap().clone();
        let crawl = ticker
            .layers
            .iter()
            .find(|l| is_timed(&l.kind))
            .unwrap()
            .clone();
        let mut ch = ChannelState::default();
        ch.apply(&p, Command::take("ticker", "ticker")).unwrap();
        let key = ch.layers.keys().next().copied().unwrap();
        let zone = Some(key);
        let ctl = |c| Command::Widget {
            zone: None,
            layer: zone,
            target: crawl.name.clone(),
            control: c,
        };
        let age = |ch: &ChannelState| ch.layers[&key].layer_age(&crawl);
        ch.tick(10.0);
        assert_eq!(age(&ch), 10.0);
        ch.apply(&p, ctl(WidgetControl::Pause)).unwrap();
        ch.tick(5.0);
        assert_eq!(age(&ch), 10.0);
        ch.apply(&p, ctl(WidgetControl::Toggle)).unwrap();
        ch.tick(5.0);
        assert_eq!(age(&ch), 15.0);
        ch.apply(&p, ctl(WidgetControl::Reset)).unwrap();
        ch.tick(3.0);
        assert_eq!(age(&ch), 3.0);
        assert!(matches!(
            ch.apply(
                &p,
                Command::Widget {
                    zone: None,
                    layer: zone,
                    target: "nope".into(),
                    control: WidgetControl::Start
                }
            ),
            Err(PlayoutError::UnknownWidget(_))
        ));

        // Manual start: waits at zero until started.
        let t = p.templates.iter_mut().find(|t| t.id == "ticker").unwrap();
        t.layers
            .iter_mut()
            .find(|l| l.id == crawl.id)
            .unwrap()
            .manual_start = true;
        let crawl = p
            .template("ticker")
            .unwrap()
            .layers
            .iter()
            .find(|l| l.id == crawl.id)
            .unwrap()
            .clone();
        let mut ch = ChannelState::default();
        ch.apply(&p, Command::take("ticker", "ticker")).unwrap();
        ch.tick(20.0);
        let item = |ch: &ChannelState| ch.layers.values().next().unwrap().layer_age(&crawl);
        assert_eq!(item(&ch), 0.0);
        ch.apply(
            &p,
            Command::Widget {
                zone: None,
                layer: zone,
                target: "*".into(),
                control: WidgetControl::Start,
            },
        )
        .unwrap();
        ch.tick(4.0);
        assert_eq!(item(&ch), 4.0);
    }

    #[test]
    fn drafts_stay_off_air_until_published() {
        let mut p = crate::sample::demo_project();
        let mut t = p.template("lower-third").unwrap().clone();
        let before = t.duration;
        t.duration = before + 10.0;
        p.save_draft(t);
        // On air still uses the published template; the designer sees the draft.
        assert_eq!(p.template("lower-third").unwrap().duration, before);
        assert_eq!(p.draft("lower-third").unwrap().duration, before + 10.0);
        assert_eq!(p.design_templates().count(), p.templates.len());
        assert_eq!(p.publish("lower-third"), Some(1));
        assert_eq!(p.template("lower-third").unwrap().duration, before + 10.0);
        assert!(p.drafts.is_empty());
        // A new template is a draft until it is published.
        let mut n = p.template("clock").unwrap().clone();
        n.id = "new".into();
        p.save_draft(n);
        assert!(p.template("new").is_none());
        assert_eq!(p.design_templates().count(), p.templates.len() + 1);
        let mut ch = ChannelState::default();
        assert!(ch.apply(&p, Command::take("top-right", "new")).is_err());
        p.publish("new");
        assert!(ch.apply(&p, Command::take("top-right", "new")).is_ok());
    }
}
