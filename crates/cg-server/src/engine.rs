//! Playout clocks: one task per channel advances its timeline at the
//! channel frame rate, notifies clients and feeds the channel's outputs.

use std::sync::{mpsc, Arc};
use std::time::Duration;

use cg_core::{ChannelState, Project};
use cg_output::ndi::NdiSender;
use cg_output::sdi::DeckLinkOutput;
use cg_output::st2110::St2110Sender;
use cg_output::{OutputError, OutputSink};
use cg_render::{OutputFormat, Renderer};
use tokio::time::{interval, MissedTickBehavior};

use crate::config::ChannelConfig;
use crate::state::{ChannelRt, OutputStatus, Shared};

/// A started output and its id (for its status).
struct Sink {
    id: String,
    sink: Box<dyn OutputSink>,
    failing: bool,
}

fn open_outputs(
    cfg: &ChannelConfig,
    outputs: &crate::config::OutputsConfig,
    period: Duration,
    status: &OutputStatus,
) -> Vec<Sink> {
    let mut sinks = Vec::new();
    let mut opened =
        |id: &str, name: &str, kind: &str, r: Result<Box<dyn OutputSink>, OutputError>| match r {
            Ok(sink) => {
                status.set(&cfg.id, id, true, "Running");
                sinks.push(Sink {
                    id: id.to_string(),
                    sink,
                    failing: false,
                });
            }
            Err(e) => {
                tracing::error!(
                    channel = cfg.name,
                    output = name,
                    "cannot start {kind} output: {e}"
                );
                status.set_detailed(&cfg.id, id, false, short(&e), e.to_string());
            }
        };
    for o in &outputs.st2110 {
        let r = St2110Sender::start(o.clone(), period).map(|s| Box::new(s) as Box<dyn OutputSink>);
        opened(&o.id, &o.name, "ST 2110", r);
    }
    for o in &outputs.sdi {
        let r = DeckLinkOutput::open(o.clone()).map(|s| Box::new(s) as Box<dyn OutputSink>);
        opened(&o.id, &o.name, "SDI", r);
    }
    let rate = (cfg.frame_rate.num, cfg.frame_rate.den);
    for o in &outputs.ndi {
        let r = NdiSender::open(o.clone(), rate).map(|s| Box::new(s) as Box<dyn OutputSink>);
        opened(&o.id, &o.name, "NDI", r);
    }
    if let Some(path) = cg_output::ndi::loaded_path() {
        for o in &outputs.ndi {
            if sinks.iter().any(|s| s.id == o.id) {
                status.set_detailed(
                    &cfg.id,
                    &o.id,
                    true,
                    "Running",
                    format!("NDI runtime: {path}"),
                );
            }
        }
    }
    sinks
}

/// An error as the outputs page shows it (details stay in the log).
fn short(e: &OutputError) -> String {
    match e {
        OutputError::Unsupported(m) => m.split(" (").next().unwrap_or(m).to_string(),
        e => e.to_string(),
    }
}

/// Starts every channel; the returned handles are aborted on restart.
pub fn start(state: &Shared) -> Vec<tokio::task::JoinHandle<()>> {
    cg_output::ndi::set_library_path(&state.config.ndi_library);
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
    state.output_status.reset(&cfg.id);
    // One render thread per picture (main + renditions) that has baseband
    // outputs, so the clock never blocks and each output gets its own size.
    let mut render_txs = Vec::new();
    for (id, width, height, outputs) in cfg.pictures() {
        let sinks = open_outputs(cfg, outputs, period, &state.output_status);
        if sinks.is_empty() {
            continue;
        }
        let (tx, rx) = mpsc::sync_channel::<RenderJob>(1);
        let assets = state.assets_dir();
        let out = OutputFormat { width, height };
        let tz = state.config.timezone.clone();
        std::thread::Builder::new()
            .name(format!("cg-render-{}-{id}", cfg.id))
            .spawn({
                let (status, channel) = (state.output_status.clone(), cfg.id.clone());
                move || render_loop(Renderer::new(assets), out, tz, rx, sinks, status, channel)
            })
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
                // Rows going on by themselves, values set by hand for a time:
                // the data is read again for them.
                let rows = st.auto_rows(p);
                let freed = st.expire_manual(crate::state::now_ms().max(0) as u64);
                if rows || freed {
                    crate::state::bind_state(p, &mut st, &state.data.store(), None, None);
                    changed = true;
                }
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
    mut sinks: Vec<Sink>,
    status: Arc<OutputStatus>,
    channel_id: String,
) {
    while let Ok((project, channel)) = rx.recv() {
        let frame = match project {
            Some(p) => renderer.render_channel(&p, &channel, out, &tz),
            None => cg_render::Frame::blank(out.width, out.height),
        };
        for s in &mut sinks {
            match s.sink.push(&frame) {
                Ok(()) | Err(OutputError::Dropped) => {
                    if s.failing {
                        s.failing = false;
                        status.set(&channel_id, &s.id, true, "Running");
                    }
                }
                Err(e) => {
                    // Report a failure once, not every frame.
                    if !s.failing {
                        tracing::warn!(output = s.sink.name(), "{e}");
                        status.set_detailed(&channel_id, &s.id, false, short(&e), e.to_string());
                        s.failing = true;
                    }
                }
            }
        }
    }
}
