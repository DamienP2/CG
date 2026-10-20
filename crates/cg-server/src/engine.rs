//! Playout: one clock thread per channel ticks at the channel frame rate,
//! advances the timelines, notifies clients and feeds the channel's outputs.
//!
//! Smoothness comes from three things:
//! - the clock aims at absolute deadlines (start + n × period), sleeping most
//!   of the way and spinning the last fraction of a millisecond, so it
//!   neither drifts nor bunches frames up;
//! - each picture is rendered one tick ahead of when it is sent: at every tick
//!   the outputs get the latest finished frame, the previous one again when a
//!   render is late, so they keep an even cadence instead of skipping;
//! - each output sends from its own thread, the newest frame winning: a slow
//!   one (ffmpeg behind, a network hiccup) holds back neither the renderer nor
//!   the other outputs. Frames are shared, never copied.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use cg_core::{ChannelState, Project};
use cg_output::ndi::NdiSender;
use cg_output::sdi::DeckLinkOutput;
use cg_output::st2110::St2110Sender;
use cg_output::stream::StreamSender;
use cg_output::{OutputError, OutputSink};
use cg_render::{Frame, OutputFormat, Renderer};

use crate::config::ChannelConfig;
use crate::perf::{ClockStats, PictureStats, SinkStats};
use crate::state::{ChannelRt, OutputStatus, Shared};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// A started output.
struct Opened {
    id: String,
    kind: &'static str,
    name: String,
    sink: Box<dyn OutputSink>,
}

fn open_outputs(
    cfg: &ChannelConfig,
    outputs: &crate::config::OutputsConfig,
    size: (u32, u32),
    period: Duration,
    status: &OutputStatus,
    hls_root: &std::path::Path,
) -> Vec<Opened> {
    let mut sinks = Vec::new();
    let mut opened = |id: &str,
                      name: &str,
                      kind: &'static str,
                      r: Result<Box<dyn OutputSink>, OutputError>| match r {
        Ok(sink) => {
            status.set(&cfg.id, id, true, "Running");
            sinks.push(Opened {
                id: id.to_string(),
                kind,
                name: name.to_string(),
                sink,
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
        opened(&o.id, &o.name, "st2110", r);
    }
    for o in &outputs.sdi {
        let r = DeckLinkOutput::open(o.clone()).map(|s| Box::new(s) as Box<dyn OutputSink>);
        opened(&o.id, &o.name, "sdi", r);
    }
    let rate = (cfg.frame_rate.num, cfg.frame_rate.den);
    for o in &outputs.ndi {
        let r = NdiSender::open(o.clone(), rate).map(|s| Box::new(s) as Box<dyn OutputSink>);
        opened(&o.id, &o.name, "ndi", r);
    }
    for o in &outputs.streams {
        let hls = (o.protocol == cg_output::stream::Protocol::Hls).then(|| hls_root.join(&o.id));
        let r = StreamSender::open(o.clone(), size.0, size.1, rate, hls)
            .map(|s| Box::new(s) as Box<dyn OutputSink>);
        opened(&o.id, &o.name, "stream", r);
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

/// Starts every channel. The tasks end by themselves once the cycle closes
/// (`state.closing`), after their outputs have stopped.
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

// ---------------------------------------------------------------- outputs --

/// A frame and the tick it is for.
type Timed = (Arc<Frame>, SystemTime);
/// The last frame a picture rendered, and its number.
type Latest = Arc<Mutex<Option<(u64, Arc<Frame>)>>>;

/// The next frame for one output's thread: the newest wins.
#[derive(Default)]
struct Mailbox {
    /// The frame and its tick; closed.
    slot: Mutex<(Option<Timed>, bool)>,
    ready: Condvar,
}

struct OutputThread {
    mailbox: Arc<Mailbox>,
    stats: Arc<SinkStats>,
    thread: std::thread::JoinHandle<()>,
}

impl OutputThread {
    fn start(o: Opened, stats: Arc<SinkStats>, status: Arc<OutputStatus>, channel: String) -> Self {
        let mailbox = Arc::new(Mailbox::default());
        let thread = std::thread::Builder::new()
            .name(format!("cg-out-{}", o.id))
            .spawn({
                let (mailbox, stats) = (mailbox.clone(), stats.clone());
                move || output_loop(o, &mailbox, &stats, &status, &channel)
            })
            .expect("spawn output thread");
        Self {
            mailbox,
            stats,
            thread,
        }
    }

    fn send(&self, frame: Arc<Frame>, at: SystemTime) {
        let mut slot = lock(&self.mailbox.slot);
        // The previous one was never taken: the output is behind.
        if slot.0.replace((frame, at)).is_some() {
            self.stats.dropped();
        }
        self.mailbox.ready.notify_one();
    }

    /// Stops the thread once its frame is out; the output closes with it.
    fn close(self) {
        lock(&self.mailbox.slot).1 = true;
        self.mailbox.ready.notify_one();
        let _ = self.thread.join();
    }
}

fn output_loop(
    o: Opened,
    mailbox: &Mailbox,
    stats: &SinkStats,
    status: &OutputStatus,
    channel: &str,
) {
    let Opened { id, mut sink, .. } = o;
    let mut failing = false;
    let mut looked = Instant::now() - Duration::from_secs(5);
    loop {
        let (frame, at) = {
            let mut slot = lock(&mailbox.slot);
            loop {
                if let Some(f) = slot.0.take() {
                    break f;
                }
                if slot.1 {
                    return;
                }
                slot = mailbox.ready.wait(slot).unwrap_or_else(|p| p.into_inner());
            }
        };
        let t = Instant::now();
        let r = sink.push(&frame, at);
        stats.sent(t.elapsed(), r.is_ok());
        match r {
            Ok(()) | Err(OutputError::Dropped) => {
                if failing {
                    failing = false;
                    status.set(channel, &id, true, "Running");
                }
            }
            Err(e) => {
                // Report a failure once, not every frame.
                if !failing {
                    tracing::warn!(output = sink.name(), "{e}");
                    status.set_detailed(channel, &id, false, short(&e), e.to_string());
                    failing = true;
                }
            }
        }
        if looked.elapsed() >= Duration::from_secs(1) {
            looked = Instant::now();
            stats.set_process(sink.process());
            if let Some(w) = sink.work_time() {
                stats.set_work(w);
            }
        }
    }
}

// --------------------------------------------------------------- pictures --

/// One picture (main or a rendition) with outputs: its render thread, the
/// latest frame it finished, and its outputs.
struct Picture {
    jobs: mpsc::SyncSender<RenderJob>,
    /// (render number, frame).
    latest: Latest,
    sent: u64,
    stats: Arc<PictureStats>,
    outputs: Vec<OutputThread>,
    render: std::thread::JoinHandle<()>,
}

impl Picture {
    /// Gives every output the latest frame (the same as last tick if the
    /// next one is not ready yet).
    fn dispatch(&mut self, at: SystemTime) {
        let Some((n, frame)) = lock(&self.latest).clone() else {
            return;
        };
        if n == self.sent {
            self.stats.repeated();
        }
        self.sent = n;
        for o in &self.outputs {
            o.send(frame.clone(), at);
        }
    }

    /// Asks for the next frame; the renderer, if still busy, skips this one.
    fn request(&self, job: RenderJob) {
        let _ = self.jobs.try_send(job);
    }

    fn close(self) {
        drop(self.jobs);
        let _ = self.render.join();
        for o in self.outputs {
            o.close();
        }
    }
}

fn render_loop(
    mut renderer: Renderer,
    out: OutputFormat,
    tz: String,
    rx: mpsc::Receiver<RenderJob>,
    latest: Latest,
    stats: Arc<PictureStats>,
) {
    let mut n = 0u64;
    let mut blank: Option<Arc<Frame>> = None;
    while let Ok((project, channel)) = rx.recv() {
        let t = Instant::now();
        let frame = match project {
            Some(p) => Arc::new(renderer.render_channel(&p, &channel, out, &tz)),
            // Nothing loaded: the same black frame every time.
            None => blank
                .get_or_insert_with(|| Arc::new(Frame::blank(out.width, out.height)))
                .clone(),
        };
        stats.rendered(t.elapsed());
        n += 1;
        *lock(&latest) = Some((n, frame));
    }
}

/// Opens a channel's outputs and starts a render thread per picture that has some.
fn start_pictures(state: &Shared, cfg: &ChannelConfig) -> Vec<Picture> {
    let period = cfg.frame_rate.frame_duration();
    let mut pictures = Vec::new();
    for (id, width, height, outputs) in cfg.pictures() {
        let hls = state.hls_dir().join(&cfg.id).join(id);
        let opened = open_outputs(
            cfg,
            outputs,
            (width, height),
            period,
            &state.output_status,
            &hls,
        );
        if opened.is_empty() {
            continue;
        }
        let name = cfg
            .renditions
            .iter()
            .find(|r| r.id == id)
            .map_or("Main", |r| r.name.as_str());
        let stats = state.perf.picture(&cfg.id, id, name, width, height);
        let outputs = opened
            .into_iter()
            .map(|o| {
                let s = stats.output(&o.id, o.kind, &o.name);
                OutputThread::start(o, s, state.output_status.clone(), cfg.id.clone())
            })
            .collect();
        let (jobs, rx) = mpsc::sync_channel::<RenderJob>(1);
        let latest = Arc::new(Mutex::new(None));
        let render = std::thread::Builder::new()
            .name(format!("cg-render-{}-{id}", cfg.id))
            .spawn({
                let assets = state.assets_dir();
                let out = OutputFormat { width, height };
                let tz = state.config.timezone.clone();
                let live = state.inputs.clone();
                let (latest, stats) = (latest.clone(), stats.clone());
                move || {
                    let mut r = Renderer::new(assets);
                    r.set_live(live);
                    render_loop(r, out, tz, rx, latest, stats)
                }
            })
            .expect("spawn render thread");
        pictures.push(Picture {
            jobs,
            latest,
            sent: 0,
            stats,
            outputs,
            render,
        });
    }
    pictures
}

// ------------------------------------------------------------------ clock --

/// Sets the flag when dropped (the channel task was cancelled).
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

async fn run_channel(state: Shared, ch: Arc<ChannelRt>) {
    let id = ch.config.id.clone();
    state.output_status.reset(&id);
    state.perf.reset_channel(&id);
    let stop = Arc::new(AtomicBool::new(false));
    let _guard = StopOnDrop(stop.clone());
    let (done_tx, mut done) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::runtime::Handle::current();
    let spawned = std::thread::Builder::new()
        .name(format!("cg-clock-{id}"))
        .spawn({
            let (state, ch, stop) = (state.clone(), ch.clone(), stop.clone());
            move || {
                // Opening outputs can take a moment (ffmpeg, NDI runtime).
                let pictures = start_pictures(&state, &ch.config);
                let stats = state.perf.clock(&ch.config.id);
                clock(&handle, &state, &ch, pictures, &stop, &stats);
                let _ = done_tx.send(());
            }
        });
    if let Err(e) = spawned {
        tracing::error!(
            channel = ch.config.name,
            "cannot start the channel clock: {e}"
        );
        return;
    }
    let mut closing = state.closing.subscribe();
    tokio::select! {
        _ = closing.wait_for(|c| *c) => {}
        _ = &mut done => return,
    }
    // Ends the clock, then waits for the outputs to close (an SRT port, an
    // NDI name: the next engine cycle may open the same ones).
    stop.store(true, Ordering::Relaxed);
    let _ = done.await;
}

/// Waits for `due`: sleeps most of the way, then spins the rest (sleeping
/// alone can wake up a millisecond or more late).
fn wait_until(due: Instant) {
    let spin = if cfg!(windows) {
        Duration::from_micros(1500)
    } else {
        Duration::from_micros(300)
    };
    loop {
        let now = Instant::now();
        if now >= due {
            return;
        }
        let left = due - now;
        if left > spin {
            std::thread::sleep(left - spin);
        } else {
            std::hint::spin_loop();
            std::thread::yield_now();
        }
    }
}

fn clock(
    rt: &tokio::runtime::Handle,
    state: &Shared,
    ch: &Arc<ChannelRt>,
    mut pictures: Vec<Picture>,
    stop: &AtomicBool,
    stats: &ClockStats,
) {
    let period = ch.config.frame_rate.frame_duration();
    let secs = period.as_secs_f64();
    let (start, wall) = (Instant::now(), SystemTime::now());
    let mut n: u64 = 0;
    let mut saved_at = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        n += 1;
        let due = start + Duration::from_secs_f64(n as f64 * secs);
        wait_until(due);
        let late = Instant::now().saturating_duration_since(due);
        stats.ticked(late);
        // Stalled (machine overloaded, suspended): carry on from now rather
        // than racing through the missed ticks.
        if late > period * 2 {
            let behind = (late.as_secs_f64() / secs) as u64;
            n += behind;
            stats.skipped(behind);
        }
        // Frame times on the clock's own steady scale (RTP timestamps).
        let at = wall + Duration::from_secs_f64(n as f64 * secs);
        for p in &mut pictures {
            p.dispatch(at);
        }
        let job = rt.block_on(advance(state, ch, &mut saved_at));
        for p in &pictures {
            p.request(job.clone());
        }
    }
    for p in pictures {
        p.close();
    }
}

/// One tick of the channel: timelines, automatic steps, clients told.
async fn advance(state: &Shared, ch: &ChannelRt, saved_at: &mut Instant) -> RenderJob {
    let channel_fps = ch.config.frame_rate.as_f64().max(1.0);
    let pid = ch.project_id.read().await.clone();
    let project = match pid.clone() {
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
            // Auto next between the graphics of a playlist.
            if let Some(taken) = st.auto_next_taken(p) {
                let store = state.data.store();
                crate::state::bind_state(p, &mut st, &store, None, None);
                // Items reading their sources "on take" read them now.
                for id in &taken {
                    crate::state::bind_state(p, &mut st, &store, None, Some(id));
                }
                changed = true;
            }
            // Countdowns at zero firing their trigger.
            for name in st.zero_triggers(p, &state.config.timezone) {
                let _ = st.apply(p, cg_core::playout::Command::Trigger { name });
                changed = true;
            }
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
        state.broadcast_channel(ch).await;
    }
    // What is on air, on disk at most once a second (a restart puts it back).
    if saved_at.elapsed() >= Duration::from_secs(1) && ch.dirty.swap(false, Ordering::Relaxed) {
        *saved_at = Instant::now();
        let (dir, id, snap) = (
            state.data_dir.clone(),
            ch.config.id.clone(),
            snapshot.clone(),
        );
        tokio::task::spawn_blocking(move || crate::state::save_on_air(&dir, &id, pid, snap));
    }
    (project, snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Slow(Arc<Mutex<Vec<u64>>>);

    impl OutputSink for Slow {
        fn name(&self) -> &str {
            "slow"
        }
        fn push(&mut self, f: &Arc<Frame>, _: SystemTime) -> Result<(), OutputError> {
            std::thread::sleep(Duration::from_millis(30));
            lock(&self.0).push(f.width as u64);
            Ok(())
        }
    }

    /// A slow output gets the newest frame and never holds back the sender.
    #[test]
    fn a_slow_output_takes_the_newest_frame() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let perf = crate::perf::Perf::default();
        let pic = perf.picture("c", "main", "Main", 1, 1);
        let stats = pic.output("o", "ndi", "O");
        let o = OutputThread::start(
            Opened {
                id: "o".into(),
                kind: "ndi",
                name: "O".into(),
                sink: Box::new(Slow(got.clone())),
            },
            stats,
            Arc::new(OutputStatus::default()),
            "c".into(),
        );
        let t = Instant::now();
        for w in 1..=10 {
            o.send(Arc::new(Frame::blank(w, 1)), SystemTime::now());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(t.elapsed() < Duration::from_millis(200));
        o.close();
        let got = lock(&got).clone();
        // The first, then whatever was newest each time it was free; the last one always.
        assert_eq!(got.first(), Some(&1));
        assert_eq!(got.last(), Some(&10));
        assert!(got.len() < 10 && got.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn the_clock_waits_precisely() {
        let start = Instant::now();
        let mut late: Vec<Duration> = (1..=40u32)
            .map(|n| {
                let due = start + Duration::from_millis(5) * n;
                wait_until(due);
                Instant::now() - due
            })
            .collect();
        late.sort();
        // A busy test machine preempts some; the typical one is on time.
        assert!(late[20] < Duration::from_millis(1), "{late:?}");
    }
}
