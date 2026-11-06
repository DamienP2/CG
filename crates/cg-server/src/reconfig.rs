//! Settings applied while the engine runs: what changed decides whether the
//! engine starts again (every output closed then opened: a cut on air) or
//! the change is made in place, the rest going on untouched.
//!
//! In place: the time, the video inputs and the tracked cameras (each
//! started again alone when its settings changed), and a channel's outputs
//! (NDI, streams, ST 2110, HTML5: only those added, changed or removed are
//! closed or opened, between two frames). Anything else (formats, frame
//! rates, renditions, SDI outputs, the hardware, the network, security…)
//! starts the engine again, as before.

use std::sync::Arc;

use crate::config::{ChannelConfig, OutputsConfig, ServerConfig};
use crate::state::Shared;

/// What a change of the settings takes.
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// The engine starts again.
    Restart,
    /// Made in place: the inputs (when they changed) and these channels' outputs.
    InPlace { inputs: bool, channels: Vec<String> },
}

/// What going from `before` to `after` takes.
pub fn plan(before: &ServerConfig, after: &ServerConfig) -> Plan {
    let mut same = before.clone();
    // The time is set by itself (`timectl`).
    same.time = after.time.clone();
    let inputs = same.inputs != after.inputs;
    same.inputs = after.inputs.clone();
    if same.channels.len() != after.channels.len() {
        return Plan::Restart;
    }
    let mut channels = Vec::new();
    for (was, now) in same.channels.iter_mut().zip(&after.channels) {
        if was == now {
            continue;
        }
        match with_outputs(was, now) {
            Some(c) if c == *now => {
                channels.push(now.id.clone());
                *was = c;
            }
            _ => return Plan::Restart,
        }
    }
    if same == *after {
        Plan::InPlace { inputs, channels }
    } else {
        Plan::Restart
    }
}

/// `was` with the outputs of `now`, when only outputs that can change in
/// place differ (not the SDI ones: the channel may follow a card's clock).
fn with_outputs(was: &ChannelConfig, now: &ChannelConfig) -> Option<ChannelConfig> {
    if was.id != now.id || was.renditions.len() != now.renditions.len() {
        return None;
    }
    let mut c = was.clone();
    let take = |a: &mut OutputsConfig, b: &OutputsConfig| {
        if a.sdi != b.sdi {
            return false;
        }
        *a = b.clone();
        true
    };
    if !take(&mut c.outputs, &now.outputs) || !take(&mut c.unwired, &now.unwired) {
        return None;
    }
    for (r, n) in c.renditions.iter_mut().zip(&now.renditions) {
        if r.id != n.id || !take(&mut r.outputs, &n.outputs) {
            return None;
        }
    }
    Some(c)
}

/// Makes `plan` (in place) with the settings `cfg`, saved already.
pub fn apply(s: &Shared, cfg: &ServerConfig, inputs: bool, channels: &[String]) {
    s.config.store(Arc::new(cfg.clone()));
    if inputs {
        s.inputs.apply(&cfg.inputs);
        s.tracking.apply(
            &cfg.inputs,
            crate::hardware::interface_ip(&cfg.hardware.network.tracking),
        );
        s.people.apply(&cfg.inputs, &s.inputs, &s.tracking);
        s.data.set_cameras(&cfg.inputs);
        tracing::info!("inputs applied");
    }
    for id in channels {
        let (Some(ch), Some(c)) = (s.channel(id), cfg.channels.iter().find(|c| &c.id == id)) else {
            continue;
        };
        let c = Arc::new(c.clone());
        ch.config.store(c.clone());
        // Its clock takes them at the next tick.
        tracing::info!(channel = c.name, "outputs applied");
        *ch.next.lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Rendition;

    fn base() -> ServerConfig {
        let mut c = ServerConfig::default();
        let ch: ChannelConfig = serde_json::from_value(serde_json::json!({
            "id": "news", "name": "News", "width": 1920, "height": 1080,
            "frameRate": {"num": 25, "den": 1},
            "outputs": {"ndi": [{"id": "ndi-1", "name": "PGM", "enabled": true}]}
        }))
        .unwrap();
        c.channels = vec![ch];
        c
    }

    #[test]
    fn nothing_changed_is_made_in_place() {
        let c = base();
        assert_eq!(
            plan(&c, &c),
            Plan::InPlace {
                inputs: false,
                channels: vec![]
            }
        );
    }

    #[test]
    fn an_output_added_or_removed_is_made_in_place() {
        let before = base();
        let mut after = before.clone();
        after.channels[0].outputs.ndi.push(
            serde_json::from_value(
                serde_json::json!({"id": "ndi-2", "name": "Clean", "enabled": true}),
            )
            .unwrap(),
        );
        assert_eq!(
            plan(&before, &after),
            Plan::InPlace {
                inputs: false,
                channels: vec!["news".into()]
            }
        );
        after.channels[0].outputs.ndi.clear();
        assert!(matches!(plan(&before, &after), Plan::InPlace { .. }));
    }

    #[test]
    fn inputs_are_made_in_place() {
        let before = base();
        let mut after = before.clone();
        after.inputs.push(
            serde_json::from_value(
                serde_json::json!({"id": "cam-1", "name": "Cam", "kind": "tracking"}),
            )
            .unwrap(),
        );
        assert_eq!(
            plan(&before, &after),
            Plan::InPlace {
                inputs: true,
                channels: vec![]
            }
        );
    }

    #[test]
    fn a_format_sdi_or_rendition_change_starts_again() {
        let before = base();
        let mut after = before.clone();
        after.channels[0].frame_rate.num = 50;
        assert_eq!(plan(&before, &after), Plan::Restart);
        let mut after = before.clone();
        after.channels[0].outputs.sdi.push(
            serde_json::from_value(
                serde_json::json!({"id": "sdi-1", "name": "SDI", "enabled": true, "device": 0}),
            )
            .unwrap(),
        );
        assert_eq!(plan(&before, &after), Plan::Restart);
        let mut after = before.clone();
        after.channels[0].renditions.push(
            serde_json::from_value::<Rendition>(
                serde_json::json!({"id": "v", "name": "9:16", "width": 1080, "height": 1920}),
            )
            .unwrap(),
        );
        assert_eq!(plan(&before, &after), Plan::Restart);
        let mut after = before.clone();
        after.name = "Other".into();
        assert_eq!(plan(&before, &after), Plan::Restart);
    }
}
