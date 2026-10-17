//! Playout clocks: one task per channel advances its timeline at the
//! channel frame rate, notifies clients and feeds the channel's outputs.

use std::sync::{mpsc, Arc};
use std::time::Duration;

use cg_core::{ChannelState, Project};
use cg_output::sdi::DeckLinkOutput;
use cg_output::st2110::St2110Sender;
use cg_output::{OutputError, OutputSink};
use cg_render::{OutputFormat, Renderer};
use tokio::time::{interval, MissedTickBehavior};

use crate::config::ChannelConfig;
use crate::state::{ChannelRt, Shared};

fn open_outputs(
    cfg: &ChannelConfig,
    outputs: &crate::config::OutputsConfig,
    period: Duration,
) -> Vec<Box<dyn OutputSink>> {
    let mut sinks: Vec<Box<dyn OutputSink>> = Vec::new();
    for o in &outputs.st2110 {
        match St2110Sender::start(o.clone(), period) {
            Ok(s) => sinks.push(Box::new(s)),
            Err(e) => tracing::error!(
                channel = cfg.name,
                output = o.name,
                "cannot start ST 2110 output: {e}"
            ),
        }
    }
    for o in &outputs.sdi {
        match DeckLinkOutput::open(o.clone()) {
            Ok(s) => sinks.push(Box::new(s)),
            Err(e) => tracing::error!(
                channel = cfg.name,
                output = o.name,
                "cannot open SDI output: {e}"
            ),
        }
    }
    sinks
}

/// Starts every channel; the returned handles are aborted on restart.
pub fn start(state: &Shared) -> Vec<tokio::task::JoinHandle<()>> {
    state
        .channels
        .values()
        .map(|ch| tokio::spawn(run_channel(state.clone(), ch.clone())))
        .collect()
}

/// The project is `None` when nothing is loaded: outputs keep sending black.
type RenderJob = (Option<Arc<Project>>, ChannelState);

async fn run_channel(state: Shared, ch: Arc<ChannelRt>) {
    let cfg = &ch.config;
    let period = cfg.frame_rate.frame_duration();
    // One render thread per picture (main + renditions) that has baseband
    // outputs, so the clock never blocks and each output gets its own size.
    let mut render_txs = Vec::new();
    for (id, width, height, outputs) in cfg.pictures() {
        let sinks = open_outputs(cfg, outputs, period);
        if sinks.is_empty() {
            continue;
        }
        let (tx, rx) = mpsc::sync_channel::<RenderJob>(1);
        let assets = state.assets_dir();
        let out = OutputFormat { width, height };
        let tz = state.config.timezone.clone();
        std::thread::Builder::new()
            .name(format!("cg-render-{}-{id}", cfg.id))
            .spawn(move || render_loop(Renderer::new(assets), out, tz, rx, sinks))
            .expect("spawn render thread");
        render_txs.push(tx);
    }

    let channel_fps = cfg.frame_rate.as_f64().max(1.0);
    let mut ticker = interval(period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let pid = ch.project_id.read().await.clone();
        let project = match pid {
            Some(id) => state.project(&id).await,
            None => None,
        };
        // Timelines are authored in project frames: re-time them for the
        // channel rate (a 25p project plays at the right speed on 50p).
        let step = project
            .as_ref()
            .map(|p| p.frame_rate.as_f64() / channel_fps)
            .unwrap_or(1.0);
        let (changed, snapshot) = {
            let mut st = ch.state.write().await;
            let mut changed = st.tick(step);
            if let Some(p) = &project {
                changed |= st.auto_resume(p);
            }
            (changed, st.clone())
        };
        if changed {
            state.broadcast_channel(&ch).await;
        }
        // Drop the frame if a renderer is late rather than queueing latency.
        for tx in &render_txs {
            let _ = tx.try_send((project.clone(), snapshot.clone()));
        }
    }
}

fn render_loop(
    mut renderer: Renderer,
    out: OutputFormat,
    tz: String,
    rx: mpsc::Receiver<RenderJob>,
    mut sinks: Vec<Box<dyn OutputSink>>,
) {
    while let Ok((project, channel)) = rx.recv() {
        let frame = match project {
            Some(p) => renderer.render_channel(&p, &channel, out, &tz),
            None => cg_render::Frame::blank(out.width, out.height),
        };
        for s in &mut sinks {
            match s.push(&frame) {
                Ok(()) | Err(OutputError::Dropped) => {}
                Err(e) => tracing::warn!(output = s.name(), "{e}"),
            }
        }
    }
}
