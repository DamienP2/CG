//! The audio outputs of the channels and the sounds the Logics play on them
//! (see `cg_output::audio`).
//!
//! The outputs live across engine restarts: an output whose settings did not
//! change keeps sending (a jingle playing goes on while the settings of
//! something else are saved).

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Instant, SystemTime};

use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use cg_core::playout::SoundAsk;
use cg_core::Project;
use cg_output::audio::{self, AudioOut, AudioOutConfig, Mixer, Pcm};
use serde::Serialize;

use crate::auth::CurrentUser;
use crate::state::Shared;

/// Decoded sounds kept, at most (samples): about 400 MB.
const CACHE_SAMPLES: usize = 100_000_000;

struct Running {
    config: AudioOutConfig,
    mixer: Arc<Mixer>,
    out: Option<AudioOut>,
    error: String,
}

struct Cached {
    modified: Option<SystemTime>,
    pcm: Arc<Pcm>,
    used: Instant,
}

/// (channel, output id) → its output.
fn outputs() -> MutexGuard<'static, BTreeMap<(String, String), Running>> {
    static O: Mutex<BTreeMap<(String, String), Running>> = Mutex::new(BTreeMap::new());
    O.lock().unwrap_or_else(|e| e.into_inner())
}

fn cache() -> MutexGuard<'static, HashMap<PathBuf, Cached>> {
    static C: std::sync::OnceLock<Mutex<HashMap<PathBuf, Cached>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The project each channel had loaded (to read its sounds ahead): the
/// version seen, and the project's id.
type Seen = (usize, String);
fn loaded() -> MutexGuard<'static, HashMap<String, Seen>> {
    static L: std::sync::OnceLock<Mutex<HashMap<String, Seen>>> = std::sync::OnceLock::new();
    L.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Starts the audio outputs of the settings, keeps the unchanged ones and
/// stops the others.
pub fn start(state: &Shared) {
    let sync = state.perf.sync.clone();
    let refclk: Arc<dyn Fn() -> Option<String> + Send + Sync> = Arc::new(move || {
        let ptp = sync.get().ptp;
        ptp.grandmaster
            .as_deref()
            .and_then(audio::ptp_clock_id)
            .map(|g| format!("{g}:{}", ptp.domain))
    });
    let mut want: BTreeMap<(String, String), AudioOutConfig> = BTreeMap::new();
    for ch in state.channels.values() {
        for a in &ch.config.audio {
            want.insert((ch.config.id.clone(), a.id.clone()), a.clone());
        }
    }
    let mut running = outputs();
    running.retain(|k, r| want.get(k) == Some(&r.config));
    for (key, config) in want {
        if running.contains_key(&key) {
            continue;
        }
        let mixer = Arc::new(Mixer::default());
        let (out, error) = if config.enabled {
            match AudioOut::start(config.clone(), mixer.clone(), refclk.clone()) {
                Ok(o) => (Some(o), String::new()),
                Err(e) => {
                    tracing::warn!(output = config.name, "audio output: {e}");
                    (None, e.to_string())
                }
            }
        } else {
            (None, String::new())
        };
        running.insert(
            key,
            Running {
                config,
                mixer,
                out,
                error,
            },
        );
    }
}

/// The place of a sound (`/assets/…`) in the media libraries, when the
/// project may play it: a sound of the shared library, or of its own.
fn library_path<'a>(project: &str, sound: &'a str) -> Option<&'a Path> {
    let rel = Path::new(sound.trim().strip_prefix("/assets/")?);
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let parts: Vec<_> = rel.components().collect();
    let allowed = match parts.as_slice() {
        [_] => true,
        [p, id, _] => p.as_os_str() == "projects" && id.as_os_str() == project,
        _ => false,
    };
    allowed.then_some(rel)
}

fn file_of(state: &Shared, project: &str, sound: &str) -> Option<PathBuf> {
    library_path(project, sound).map(|rel| state.assets_dir().join(rel))
}

/// A sound decoded (from the cache when its file did not change).
fn pcm(path: &Path) -> Result<Arc<Pcm>, String> {
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    if let Some(c) = cache().get_mut(path) {
        if c.modified == modified {
            c.used = Instant::now();
            return Ok(c.pcm.clone());
        }
    }
    let pcm = Arc::new(audio::decode(path).map_err(|e| e.to_string())?);
    let mut c = cache();
    c.insert(
        path.to_path_buf(),
        Cached {
            modified,
            pcm: pcm.clone(),
            used: Instant::now(),
        },
    );
    // The least used ones go first, over the limit.
    while c.values().map(|x| x.pcm.samples.len()).sum::<usize>() > CACHE_SAMPLES && c.len() > 1 {
        let Some(old) = c
            .iter()
            .filter(|(p, _)| p.as_path() != path)
            .min_by_key(|(_, x)| x.used)
            .map(|(p, _)| p.clone())
        else {
            break;
        };
        c.remove(&old);
    }
    Ok(pcm)
}

/// The mixers of a channel's outputs: `output` ("" = every one).
fn mixers(channel: &str, output: &str) -> Vec<Arc<Mixer>> {
    outputs()
        .iter()
        .filter(|((ch, id), r)| {
            ch == channel && (output.is_empty() || id == output) && r.out.is_some()
        })
        .map(|(_, r)| r.mixer.clone())
        .collect()
}

/// Does what the Logics of a channel asked (in the background: a sound not
/// read yet is decoded first).
pub fn run(state: &Shared, channel: &str, project: &Project, asks: Vec<SoundAsk>) {
    if asks.is_empty() {
        return;
    }
    let jobs: Vec<(SoundAsk, Option<PathBuf>)> = asks
        .into_iter()
        .map(|a| {
            let file = match &a {
                SoundAsk::Play { sound, .. } => file_of(state, &project.id, sound),
                SoundAsk::Stop { .. } => None,
            };
            (a, file)
        })
        .collect();
    let channel = channel.to_string();
    // In order: a stop after a play stops it.
    tokio::task::spawn_blocking(move || {
        for (ask, file) in jobs {
            match ask {
                SoundAsk::Play {
                    sound,
                    volume,
                    output,
                    looped,
                    fade,
                } => {
                    let Some(file) = file else {
                        tracing::warn!("sound {sound}: not in the media libraries of the project");
                        continue;
                    };
                    match pcm(&file) {
                        Ok(p) => {
                            for m in mixers(&channel, &output) {
                                m.play(&sound, p.clone(), volume, looped, fade);
                            }
                        }
                        Err(e) => tracing::warn!("sound {sound}: {e}"),
                    }
                }
                SoundAsk::Stop { sound, fade } => {
                    let key = (!sound.is_empty()).then_some(sound.as_str());
                    for m in mixers(&channel, "") {
                        m.stop(key, fade);
                    }
                }
            }
        }
    });
}

/// The sounds a project's Logics play.
fn sounds_of(project: &Project) -> Vec<String> {
    let mut out = Vec::new();
    let logics = std::iter::once(&project.logic).chain(project.templates.iter().map(|t| &t.logic));
    for l in logics {
        for n in &l.nodes {
            if let cg_core::logic::NodeKind::PlaySound { sound, .. } = &n.kind {
                if !sound.is_empty() && !out.contains(sound) {
                    out.push(sound.clone());
                }
            }
        }
    }
    out
}

/// Called each tick with the project loaded on a channel: a new one has its
/// sounds read ahead (no wait at the first play); the sounds of the one
/// before stop.
pub fn loaded_on(state: &Shared, channel: &str, project: Option<&Arc<Project>>) {
    let seen = project.map_or((0, String::new()), |p| {
        (Arc::as_ptr(p) as usize, p.id.clone())
    });
    {
        let mut l = loaded();
        let before = l.insert(channel.to_string(), seen.clone());
        if before.as_ref() == Some(&seen) {
            return;
        }
        // Another project (not a new version of the same one): silence.
        if before.is_some_and(|b| !b.1.is_empty() && b.1 != seen.1) {
            for m in mixers(channel, "") {
                m.stop(None, 0.3);
            }
        }
    }
    let Some(p) = project else { return };
    let files: Vec<PathBuf> = sounds_of(p)
        .iter()
        .filter_map(|s| file_of(state, &p.id, s))
        .collect();
    if files.is_empty() || !has_outputs(channel) {
        return;
    }
    tokio::task::spawn_blocking(move || {
        for f in files {
            let _ = pcm(&f);
        }
    });
}

fn has_outputs(channel: &str) -> bool {
    outputs().keys().any(|(ch, _)| ch == channel)
}

// ── API ───────────────────────────────────────────────────────────────────

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/audio/status", get(status))
        .route("/api/audio/devices", get(devices))
        .route("/api/audio/{channel}/{id}/sdp", get(sdp))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputState {
    channel: String,
    id: String,
    name: String,
    running: bool,
    /// Packets or blocks sent so far.
    sent: u64,
    error: String,
    /// The sounds playing (their address).
    playing: Vec<String>,
}

async fn status(CurrentUser(_): CurrentUser) -> Json<Vec<OutputState>> {
    let list = outputs()
        .iter()
        .map(|((ch, id), r)| {
            let (sent, err) = r.out.as_ref().map_or((0, String::new()), |o| {
                (
                    o.stats.sent.load(std::sync::atomic::Ordering::Relaxed),
                    o.stats
                        .error
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone(),
                )
            });
            OutputState {
                channel: ch.clone(),
                id: id.clone(),
                name: r.config.name.clone(),
                running: r.out.is_some(),
                sent,
                error: if r.error.is_empty() {
                    err
                } else {
                    r.error.clone()
                },
                playing: r.mixer.playing(),
            }
        })
        .collect();
    Json(list)
}

async fn devices(CurrentUser(_): CurrentUser) -> Json<Vec<String>> {
    Json(
        tokio::task::spawn_blocking(audio::devices)
            .await
            .unwrap_or_default(),
    )
}

/// The SDP of an AES67 output (for receivers without SAP).
async fn sdp(
    State(s): State<Shared>,
    CurrentUser(_): CurrentUser,
    UrlPath((channel, id)): UrlPath<(String, String)>,
) -> axum::response::Response {
    let Some(a) = s
        .channels
        .get(&channel)
        .and_then(|c| c.config.audio.iter().find(|a| a.id == id))
    else {
        return crate::api::not_found("audio output").into_response();
    };
    let ptp = s.perf.sync.get().ptp;
    let refclk = ptp
        .grandmaster
        .as_deref()
        .and_then(audio::ptp_clock_id)
        .map(|g| format!("{g}:{}", ptp.domain));
    (
        [(axum::http::header::CONTENT_TYPE, "application/sdp")],
        a.sdp(refclk.as_deref()),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::library_path;

    #[test]
    fn only_library_sounds_of_the_project_are_played() {
        let ok = |s: &str| library_path("p1", s).is_some();
        assert!(ok("/assets/whoosh.wav"));
        assert!(ok("/assets/projects/p1/jingle.mp3"));
        assert!(!ok("/assets/projects/p2/jingle.mp3"));
        assert!(!ok("/assets/../config.json"));
        assert!(!ok("/assets/fonts/x/y.wav"));
        assert!(!ok("/etc/passwd"));
    }
}
