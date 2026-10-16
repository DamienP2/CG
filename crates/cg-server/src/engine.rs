//! Playout clock: advances the channel at the project frame rate, notifies
//! clients and feeds the baseband outputs.

use std::sync::mpsc;
use std::time::Duration;

use cg_core::ChannelState;
use cg_output::sdi::DeckLinkOutput;
use cg_output::st2110::St2110Sender;
use cg_output::{OutputError, OutputSink};
use cg_render::Renderer;
use tokio::time::{interval, MissedTickBehavior};

use crate::state::{Event, Shared};

pub fn open_outputs(state: &Shared, period: Duration) -> Vec<Box<dyn OutputSink>> {
    let mut sinks: Vec<Box<dyn OutputSink>> = Vec::new();
    for cfg in &state.config.outputs.st2110 {
        match St2110Sender::start(cfg.clone(), period) {
            Ok(s) => sinks.push(Box::new(s)),
            Err(e) => tracing::error!(name = cfg.name, "cannot start ST 2110 output: {e}"),
        }
    }
    for cfg in &state.config.outputs.sdi {
        match DeckLinkOutput::open(cfg.clone()) {
            Ok(s) => sinks.push(Box::new(s)),
            Err(e) => tracing::error!(name = cfg.name, "cannot open SDI output: {e}"),
        }
    }
    sinks
}

pub async fn run(state: Shared) {
    let rate = state.project.read().await.frame_rate;
    let period = rate.frame_duration();
    let sinks = open_outputs(&state, period);

    // Raster outputs render on a dedicated thread so the clock never blocks.
    let render_tx = if sinks.is_empty() {
        None
    } else {
        let (tx, rx) = mpsc::sync_channel::<(std::sync::Arc<cg_core::Project>, ChannelState)>(1);
        let st = state.clone();
        std::thread::Builder::new()
            .name("cg-render".into())
            .spawn(move || render_loop(st, rx, sinks))
            .expect("spawn render thread");
        Some(tx)
    };

    let mut ticker = interval(period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let (changed, snapshot) = {
            let mut ch = state.channel.write().await;
            let changed = ch.tick(1.0);
            (changed, ch.clone())
        };
        if changed {
            let _ = state.events.send(Event::Channel {
                state: snapshot.clone(),
            });
        }
        if let Some(tx) = &render_tx {
            let project = state.project.read().await.clone();
            // Drop the frame if the renderer is late rather than queueing latency.
            let _ = tx.try_send((project, snapshot));
        }
    }
}

fn render_loop(
    state: Shared,
    rx: mpsc::Receiver<(std::sync::Arc<cg_core::Project>, ChannelState)>,
    mut sinks: Vec<Box<dyn OutputSink>>,
) {
    let mut fresh = Renderer::new(state.assets_dir());
    while let Ok((project, channel)) = rx.recv() {
        // Prefer the shared renderer (keeps caches warm with previews), fall
        // back to our own if a preview request holds it.
        let frame = match state.renderer.try_lock() {
            Ok(mut r) => r.render_channel(&project, &channel),
            Err(_) => fresh.render_channel(&project, &channel),
        };
        for s in &mut sinks {
            match s.push(&frame) {
                Ok(()) | Err(OutputError::Dropped) => {}
                Err(e) => tracing::warn!(output = s.name(), "{e}"),
            }
        }
    }
}
