//! Renders a graphic to a video file with alpha, for post-production (the
//! Premiere Pro panel, or any client of `POST /api/render`).
//!
//! The clip plays the template like on air: animation in up to the hold
//! point, `hold` seconds on air (clocks, tickers… keep running), then the
//! out animation. Frames are rendered at the requested size and frame rate;
//! the project format closest to that shape (16:9, 9:16…) is used.

use std::sync::mpsc;

use cg_core::{ChannelState, Command, Data, Project};
use cg_render::{OutputFormat, Renderer};
use serde::Deserialize;

/// Longest clip accepted.
pub const MAX_SECONDS: f64 = 300.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub project_id: String,
    pub template_id: String,
    #[serde(default)]
    pub data: Data,
    pub width: u32,
    pub height: u32,
    /// Output frame rate (the sequence's).
    pub frame_rate: cg_core::FrameRate,
    /// Seconds on air between the in and out animations.
    #[serde(default = "default_hold")]
    pub hold: f64,
    /// Play the out animation at the end.
    #[serde(default = "yes")]
    pub include_out: bool,
}

fn default_hold() -> f64 {
    5.0
}
fn yes() -> bool {
    true
}

/// Renders the clip and returns a QuickTime file (PNG frames with alpha).
pub fn render_clip(
    project: &Project,
    req: &RenderRequest,
    assets: std::path::PathBuf,
    tz: &str,
) -> Result<Vec<u8>, String> {
    let template = project
        .template(&req.template_id)
        .ok_or("no such template")?;
    if !(16..=7680).contains(&req.width) || !(16..=7680).contains(&req.height) {
        return Err("invalid size".into());
    }
    let out_fps = req.frame_rate.as_f64();
    if !(1.0..=240.0).contains(&out_fps) {
        return Err("invalid frame rate".into());
    }
    let max_frames = (MAX_SECONDS * out_fps) as usize;
    // Project frames advanced per output frame.
    let step = project.frame_rate.as_f64().max(1.0) / out_fps;
    let hold_frames = (req.hold.clamp(0.0, MAX_SECONDS) * out_fps).round() as usize;

    let mut state = ChannelState::default();
    state
        .apply(
            project,
            Command::Take {
                zone: None,
                layer: Some(1),
                template_id: template.id.clone(),
                data: Some(req.data.clone()),
                rundown_id: None,
            },
        )
        .map_err(|e| e.to_string())?;
    let out = OutputFormat {
        width: req.width,
        height: req.height,
    };

    // Encode PNGs on every core while frames are rendered in order.
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, 8);
    let (job_tx, job_rx) = mpsc::sync_channel::<(usize, cg_render::Frame)>(workers * 2);
    let job_rx = std::sync::Arc::new(std::sync::Mutex::new(job_rx));
    let (done_tx, done_rx) = mpsc::channel::<(usize, Vec<u8>)>();
    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let rx = job_rx.clone();
            let tx = done_tx.clone();
            std::thread::spawn(move || loop {
                let job = rx.lock().ok().and_then(|r| r.recv().ok());
                let Some((i, frame)) = job else { break };
                let _ = tx.send((i, frame.to_png()));
            })
        })
        .collect();
    drop(done_tx);

    let mut renderer = Renderer::new(assets);
    let mut n = 0usize;
    let mut held = 0usize;
    let mut out_started = false;
    loop {
        if n >= max_frames {
            break;
        }
        let frame = renderer.render_channel(project, &state, out, tz);
        if job_tx.send((n, frame)).is_err() {
            break;
        }
        n += 1;
        let item = state.layers.get(&1);
        match item {
            None => break,
            Some(i) if i.phase == cg_core::Phase::Holding && !out_started => {
                held += 1;
                if held > hold_frames {
                    if !req.include_out {
                        break;
                    }
                    out_started = true;
                    state
                        .apply(
                            project,
                            Command::TakeOut {
                                zone: None,
                                layer: Some(1),
                            },
                        )
                        .map_err(|e| e.to_string())?;
                    if state.layers.is_empty() {
                        break;
                    }
                }
            }
            // Holding at the very end of a template without out animation.
            Some(i) if i.phase == cg_core::Phase::Holding && out_started => break,
            _ => {}
        }
        state.tick(step);
    }
    drop(job_tx);
    let mut frames: Vec<Option<Vec<u8>>> = vec![None; n];
    for (i, png) in done_rx {
        if i < frames.len() {
            frames[i] = Some(png);
        }
    }
    for h in handles {
        let _ = h.join();
    }
    let frames: Vec<Vec<u8>> = frames.into_iter().map(|f| f.unwrap_or_default()).collect();
    if frames.is_empty() || frames.iter().any(|f| f.is_empty()) {
        return Err("rendering failed".into());
    }
    Ok(cg_output::mov::write_png_mov(
        &frames,
        req.width,
        req.height,
        (req.frame_rate.num, req.frame_rate.den),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_in_hold_and_out() {
        let p = cg_core::sample::demo_project();
        let req = RenderRequest {
            project_id: p.id.clone(),
            template_id: "lower-third".into(),
            data: Data::new(),
            width: 192,
            height: 108,
            frame_rate: cg_core::FrameRate::new(25, 1),
            hold: 1.0,
            include_out: true,
        };
        let mov = render_clip(&p, &req, std::env::temp_dir(), "UTC").unwrap();
        let t = p.template("lower-third").unwrap();
        // In + 1 s hold + out, at 25 fps from a 50 fps project.
        let expected = (t.hold_frame() / 2.0) + 25.0 + (t.duration - t.out_frame().unwrap()) / 2.0;
        let count = u32::from_be_bytes(
            mov[mov.windows(4).position(|w| w == b"stsz").unwrap() + 12..][..4]
                .try_into()
                .unwrap(),
        ) as f64;
        assert!(
            (count - expected).abs() <= 3.0,
            "{count} frames, expected about {expected}"
        );
    }
}
