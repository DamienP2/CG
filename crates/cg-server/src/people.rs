//! The people a tracked camera sees, so that the layers anchored behind them
//! (`Track::behind`) are cut where they are.
//!
//! A tracking input given the video input bringing its picture (`image`)
//! has two threads finding the people in each picture: MediaPipe's selfie
//! segmenter (assets/models, Apache 2.0) run at 256 × 144 on the graphics
//! card or the processor (`crate::people_net`), its edges then laid on those
//! of the picture (guided filter at 480 × 270), steadied where they only
//! flicker, then worked as the camera's `Cut` says (contour, edge). It works while a
//! project of a channel has a graphic behind the people on that camera, or
//! while its preview is looked at.
//!
//! What passes in front can also be chosen with a brush (`Foreground::Chosen`):
//! the strokes stay on the set as the camera moves (each is re-projected
//! from the camera it was painted with to the one of the picture). A person
//! touched is kept, and followed from picture to picture once out of the
//! paint; the rest of the paint is an object, its edges laid on the picture's.
//!
//! The mixer keys Strata's fill and key over the camera as before; finding
//! the people takes time, so it delays the camera by `delay` frames, and
//! each frame shown at T is cut by the people of the camera's picture of
//! `delay` frames before T. The camera's tracking is late as much (the
//! anchored graphics stay on the delayed picture).

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tiny_skia::{IntSize, Pixmap};

use cg_core::tracking::{follow, CameraSample, People as Found};

use crate::auth::{CurrentUser, MaybeUser};
use crate::inputs::{Cut, Foreground, InputConfig, InputKind, Inputs, Stroke};
use crate::people_net::{Device, Engine, Processor};
use crate::state::Shared;
use crate::tracking::Tracking;

const MODEL: &[u8] = include_bytes!("../../../assets/models/people.onnx");
/// The model's picture.
const IN_W: usize = 256;
const IN_H: usize = 144;
/// The people found: their edges laid on the picture at this size.
const W: usize = 480;
const H: usize = 270;
/// Pictures of people kept (the frames take the one of their time).
const KEPT: usize = 16;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// How the finding of the people goes, for the Camera tracking page.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Finding them now.
    pub running: bool,
    /// Milliseconds a picture takes (the middle of the last ones).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<f64>,
    /// Frames the mixer delays the camera by.
    pub delay: u32,
    /// What finds them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<Device>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub message: String,
    /// What the strokes chose (`Foreground::Chosen`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Item>,
}

/// A person or an object chosen with the brush, and the strokes that chose it
/// (their places in `Cut::strokes`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub kind: Kind,
    pub strokes: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Person,
    Object,
}

/// The cameras whose people are found.
#[derive(Default)]
pub struct People {
    cams: Mutex<HashMap<String, Arc<Cam>>>,
}

struct Cam {
    /// The video input bringing its picture.
    image: String,
    stop: AtomicBool,
    /// Last asked for (a graphic behind the people, the preview).
    asked: Mutex<Option<Instant>>,
    /// The people found, by when their picture came.
    found: Mutex<VecDeque<(Instant, Arc<Found>)>>,
    /// Milliseconds the last pictures took.
    took: Mutex<VecDeque<f64>>,
    /// Seconds between two pictures of the camera.
    period: Mutex<f64>,
    /// How far ahead of their time frames are drawn, s (the most seen).
    lead: Mutex<f64>,
    /// Frames the mixer delays the camera by (it only grows: the mixer is set once).
    delay: AtomicU32,
    message: Mutex<String>,
    /// How they are cut out (changed while running).
    cut: Mutex<Cut>,
    /// What finds them (once started).
    device: Mutex<Option<Device>>,
    /// The newest picture found, as cut: its number, the picture, its people.
    last: Mutex<Option<Shot>>,
    /// What the strokes chose in the newest picture.
    items: Mutex<Vec<Item>>,
}

/// A picture with its people, for the page.
#[derive(Clone)]
struct Shot {
    n: u64,
    picture: Arc<Vec<[f32; 3]>>,
    found: Arc<Found>,
}

impl Cam {
    fn new(image: &str, cut: Cut) -> Self {
        Self {
            image: image.to_string(),
            stop: AtomicBool::new(false),
            asked: Mutex::new(None),
            found: Mutex::new(VecDeque::new()),
            took: Mutex::new(VecDeque::new()),
            period: Mutex::new(1.0 / 50.0),
            lead: Mutex::new(0.0),
            delay: AtomicU32::new(0),
            message: Mutex::new(String::new()),
            cut: Mutex::new(cut),
            device: Mutex::new(None),
            last: Mutex::new(None),
            items: Mutex::new(Vec::new()),
        }
    }

    fn say(&self, m: impl Into<String>) {
        *lock(&self.message) = m.into();
    }

    fn ask(&self) {
        *lock(&self.asked) = Some(Instant::now());
    }

    fn wanted(&self) -> bool {
        lock(&self.asked).is_some_and(|t| t.elapsed() < Duration::from_secs(3))
    }

    /// Milliseconds a picture takes: the middle of the last ones, and nine
    /// in ten of them (once enough came: the first ones are slower).
    fn took(&self) -> Option<(f64, f64)> {
        let took = lock(&self.took);
        if took.len() < 20 {
            return None;
        }
        let mut t: Vec<f64> = took.iter().copied().collect();
        t.sort_by(f64::total_cmp);
        Some((t[t.len() / 2], t[(t.len() * 9 / 10).min(t.len() - 1)]))
    }

    /// The frames needed: the picture coming in (one frame), found, then
    /// drawn as far ahead as the outputs draw.
    fn update_delay(&self) {
        let period = *lock(&self.period);
        let took = self.took().map_or(period * 0.8, |(_, slow)| slow / 1000.0);
        let lead = *lock(&self.lead);
        let need = 1 + ((lead + took) / period).ceil().max(1.0) as u32;
        self.delay.fetch_max(need, Ordering::Relaxed);
    }

    fn delay(&self) -> u32 {
        let d = self.delay.load(Ordering::Relaxed);
        if d == 0 {
            self.update_delay();
        }
        self.delay.load(Ordering::Relaxed)
    }

    /// The people of the picture `delay` frames before a frame shown at `at`.
    fn for_frame(&self, at: Instant) -> Option<Arc<Found>> {
        let period = *lock(&self.period);
        // The shift asked for: later pictures (+) or earlier ones (−).
        let shift = lock(&self.cut).shift.clamp(-3, 3);
        let frames = (self.delay().max(1) as i32 - 1 - shift).max(0);
        let back = Duration::from_secs_f64(period * frames as f64);
        // Its picture came a frame after it was taken.
        let want = at.checked_sub(back)?;
        let found = lock(&self.found);
        let newest = found.back()?;
        // Nothing new for a second: the camera stopped, nobody is cut.
        if newest.0 + Duration::from_secs(1) < want {
            return None;
        }
        let half = Duration::from_secs_f64(period / 2.0);
        found
            .iter()
            .rev()
            .find(|(t, _)| *t <= want + half)
            .or(found.front())
            .map(|(_, f)| f.clone())
    }
}

/// The instant a time of the wall clock falls at.
fn instant_of(t: SystemTime) -> Instant {
    let (now, wall) = (Instant::now(), SystemTime::now());
    match t.duration_since(wall) {
        Ok(ahead) => now + ahead,
        Err(e) => now.checked_sub(e.duration()).unwrap_or(now),
    }
}

impl People {
    /// Finds the people of the tracking inputs that have a picture: new
    /// and changed ones start, the others stop.
    pub fn apply(&self, configs: &[InputConfig], inputs: &Arc<Inputs>, tracking: &Arc<Tracking>) {
        let wanted: BTreeMap<&str, (&str, &Cut)> = configs
            .iter()
            .filter(|c| c.enabled && c.kind == InputKind::Tracking && !c.image.is_empty())
            .map(|c| (c.id.as_str(), (c.image.as_str(), &c.cut)))
            .collect();
        let mut cams = lock(&self.cams);
        cams.retain(|id, cam| {
            let keep = wanted
                .get(id.as_str())
                .filter(|(image, _)| *image == cam.image);
            match keep {
                Some((_, cut)) => *lock(&cam.cut) = (*cut).clone(),
                None => cam.stop.store(true, Ordering::Relaxed),
            }
            keep.is_some()
        });
        for (id, (image, cut)) in wanted {
            if cams.contains_key(id) {
                continue;
            }
            let cam = Arc::new(Cam::new(image, cut.clone()));
            let (c, inputs, tracking, name) = (
                cam.clone(),
                inputs.clone(),
                tracking.clone(),
                id.to_string(),
            );
            let spawned = std::thread::Builder::new()
                .name(format!("cg-people-{id}"))
                .spawn(move || run(c, inputs, tracking, name));
            if let Err(e) = spawned {
                cam.say(format!("cannot start: {e}"));
            }
            cams.insert(id.to_string(), cam);
        }
    }

    /// The people the cameras of a project's graphics behind the people
    /// see, for a frame shown at `shown`.
    pub fn for_project(
        &self,
        p: &cg_core::Project,
        shown: SystemTime,
    ) -> BTreeMap<String, Arc<Found>> {
        let cams = lock(&self.cams);
        let mut out = BTreeMap::new();
        if cams.is_empty() {
            return out;
        }
        let lead = shown
            .duration_since(SystemTime::now())
            .map_or(0.0, |d| d.as_secs_f64());
        let at = instant_of(shown);
        for t in &p.templates {
            let Some((id, cam)) = t.camera.as_ref().and_then(|id| cams.get_key_value(id)) else {
                continue;
            };
            {
                let mut l = lock(&cam.lead);
                if lead > *l {
                    *l = lead;
                    drop(l);
                    cam.update_delay();
                }
            }
            let behind = t
                .layers
                .iter()
                .any(|l| l.parent.is_none() && l.anchor.is_some_and(|a| a.behind));
            if !behind || out.contains_key(id) {
                continue;
            }
            cam.ask();
            if let Some(f) = cam.for_frame(at) {
                out.insert(id.clone(), f);
            }
        }
        out
    }

    /// How late the tracking of each camera with a picture is, on top of its own delay.
    pub fn delays(&self) -> Vec<(String, Duration)> {
        lock(&self.cams)
            .iter()
            .map(|(id, c)| {
                let period = *lock(&c.period);
                (
                    id.clone(),
                    Duration::from_secs_f64(period * c.delay() as f64),
                )
            })
            .collect()
    }

    pub fn status(&self, id: &str) -> Option<Status> {
        let c = lock(&self.cams).get(id)?.clone();
        let message = lock(&c.message).clone();
        let device = lock(&c.device).clone();
        let items = if lock(&c.cut).foreground == Foreground::Chosen {
            lock(&c.items).clone()
        } else {
            Vec::new()
        };
        Some(Status {
            items,
            running: c.wanted(),
            ms: c.took().map(|(mid, _)| (mid * 10.0).round() / 10.0),
            delay: c.delay(),
            device,
            message,
        })
    }

    /// The camera's newest picture (`View::Image`), or the newest one
    /// found with its people (shown, or over a band as a graphic behind
    /// them would be), and the number of that picture.
    pub fn preview(&self, id: &str, inputs: &Inputs, view: View) -> Option<(u64, Pixmap)> {
        let cam = lock(&self.cams).get(id)?.clone();
        cam.ask();
        let (n, rgb, found) = match view {
            View::Image => {
                let (n, pic, _) = inputs.latest_at(&cam.image)?;
                (n, Arc::new(shrink(&pic, W, H)), None)
            }
            _ => {
                let shot = lock(&cam.last).clone()?;
                (shot.n, shot.picture, Some(shot.found))
            }
        };
        let mut data = Vec::with_capacity(W * H * 4);
        let byte = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
        for (i, p) in rgb.iter().enumerate() {
            let m = found.as_ref().map_or(1.0, |f| f.data[i] as f32 / 255.0);
            let px = match view {
                View::Image => *p,
                View::Cut => {
                    // The people as they are, the rest darker and tinted.
                    let k = 0.28 + 0.72 * m;
                    let tint = (1.0 - k) * 0.25;
                    [p[0] * k + 0.35 * tint, p[1] * k, p[2] * k + 0.63 * tint]
                }
                View::Result => {
                    let band = band(i % W, i / W).map_or(*p, |b| {
                        let a = b[3];
                        [
                            p[0] * (1.0 - a) + b[0] * a,
                            p[1] * (1.0 - a) + b[1] * a,
                            p[2] * (1.0 - a) + b[2] * a,
                        ]
                    });
                    [
                        p[0] * m + band[0] * (1.0 - m),
                        p[1] * m + band[1] * (1.0 - m),
                        p[2] * m + band[2] * (1.0 - m),
                    ]
                }
            };
            data.extend_from_slice(&[byte(px[0]), byte(px[1]), byte(px[2]), 255]);
        }
        Some((
            n,
            Pixmap::from_vec(data, IntSize::from_wh(W as u32, H as u32)?)?,
        ))
    }

    /// Settings tried on a running camera, before they are saved.
    pub fn try_cut(&self, id: &str, cut: Cut) -> bool {
        let Some(cam) = lock(&self.cams).get(id).cloned() else {
            return false;
        };
        *lock(&cam.cut) = cut;
        true
    }

    /// Stops every camera (the server stops).
    pub fn stop(&self) {
        for c in lock(&self.cams).values() {
            c.stop.store(true, Ordering::Relaxed);
        }
    }
}

impl Drop for People {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What the preview shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    /// The camera's picture.
    Image,
    /// The people found, the rest darker.
    #[default]
    Cut,
    /// The people over a band, as over a graphic behind them.
    Result,
}

/// A lower third band in the bottom left of the picture (RGBA), where a
/// graphic behind the people would be.
fn band(x: usize, y: usize) -> Option<[f32; 4]> {
    let (u, v) = (x as f32 / W as f32, y as f32 / H as f32);
    if !(0.03..0.63).contains(&u) || !(0.69..0.88).contains(&v) {
        return None;
    }
    if v < 0.70 {
        return Some([1.0, 0.42, 0.1, 1.0]);
    }
    // Two lines of "text".
    let line = |top: f32, bottom: f32, right: f32| {
        (top..bottom).contains(&v) && (0.06..right).contains(&u)
    };
    if line(0.735, 0.79, 0.42) || line(0.815, 0.845, 0.3) {
        return Some([0.92, 0.94, 1.0, 1.0]);
    }
    Some([0.06, 0.09, 0.25, 0.92])
}

/// A picture on its way: made smaller, the people found roughly.
struct Rough {
    /// When the camera's picture came, when its finding started.
    came: Instant,
    started: Instant,
    picture: Vec<[f32; 3]>,
    people: Vec<f32>,
    /// Where the camera looked when it was taken.
    camera: Option<CameraSample>,
}

/// One camera's threads, while its people are wanted: one finds them
/// roughly in each new picture, the other lays their edges on the
/// picture's meanwhile (two pictures at a time: 50 a second on a processor).
fn run(cam: Arc<Cam>, inputs: Arc<Inputs>, tracking: Arc<Tracking>, id: String) {
    let (send, edges) = std::sync::mpsc::sync_channel::<Rough>(1);
    let c = cam.clone();
    let spawned = std::thread::Builder::new()
        .name("cg-people-edges".into())
        .spawn(move || refine_all(&c, edges));
    if let Err(e) = spawned {
        return cam.say(format!("cannot start: {e}"));
    }
    let mut last = None;
    let mut came: Option<Instant> = None;
    // The model, on what the camera asks for (made again when that changes).
    let mut engine: Option<(Processor, Engine)> = None;
    while !cam.stop.load(Ordering::Relaxed) {
        if !cam.wanted() {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }
        let asked = lock(&cam.cut).processor;
        if engine.as_ref().is_none_or(|(p, _)| *p != asked) {
            engine = None;
            match Engine::new(MODEL, IN_W, IN_H, asked) {
                Ok(e) => {
                    *lock(&cam.device) = Some(e.device.clone());
                    // The first pictures on another device are not its pace.
                    lock(&cam.took).clear();
                    engine = Some((asked, e));
                }
                Err(e) => {
                    cam.say(e);
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
        }
        let Some((_, net)) = engine.as_mut() else {
            continue;
        };
        let Some((n, pic, at)) = inputs.latest_at(&cam.image) else {
            cam.say("No picture");
            std::thread::sleep(Duration::from_millis(100));
            continue;
        };
        if Some(n) == last {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        last = Some(n);
        // The camera's pace, from when its pictures come.
        if let Some(c) = came.filter(|c| at > *c) {
            let d = (at - c).as_secs_f64();
            if (0.005..0.2).contains(&d) {
                let mut p = lock(&cam.period);
                *p = *p * 0.95 + d * 0.05;
            }
        }
        came = Some(at);
        let started = Instant::now();
        let picture = shrink(&pic, W, H);
        match rough(net, &picture) {
            Ok(people) => {
                let r = Rough {
                    came: at,
                    started,
                    picture,
                    people,
                    camera: tracking.filmed(&id, at),
                };
                if send.send(r).is_err() {
                    break;
                }
            }
            Err(e) => {
                cam.say(format!("{e}"));
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

/// The second thread: each picture's people, their edges laid, kept for the frames.
fn refine_all(cam: &Cam, pictures: std::sync::mpsc::Receiver<Rough>) {
    let mut prev: Option<(Instant, Vec<f32>)> = None;
    let mut chosen = Chosen::default();
    for (n, r) in (1u64..).zip(pictures) {
        // Steadied with the picture before only when it came just before.
        let before = prev
            .as_ref()
            .filter(|(at, _)| r.came.saturating_duration_since(*at) < Duration::from_millis(200))
            .map(|(_, m)| m.as_slice());
        let cut = lock(&cam.cut).clone();
        let (found, mask) = refine(
            &r.picture,
            &r.people,
            before,
            &cut,
            r.camera.as_ref(),
            &mut chosen,
        );
        prev = Some((r.came, mask));
        *lock(&cam.items) = chosen.items.clone();
        let found = Arc::new(found);
        *lock(&cam.last) = Some(Shot {
            n,
            picture: Arc::new(r.picture),
            found: found.clone(),
        });
        let mut f = lock(&cam.found);
        f.push_back((r.came, found));
        while f.len() > KEPT {
            f.pop_front();
        }
        drop(f);
        let mut took = lock(&cam.took);
        took.push_back(r.started.elapsed().as_secs_f64() * 1000.0);
        while took.len() > 100 {
            took.pop_front();
        }
        drop(took);
        cam.update_delay();
        cam.say("");
    }
}

/// The people of a picture (and how much of a person each point is, for
/// the next one).
#[cfg(test)]
fn find(net: &mut Engine, pic: &Pixmap, prev: Option<&[f32]>) -> anyhow::Result<(Found, Vec<f32>)> {
    let picture = shrink(pic, W, H);
    let people = rough(net, &picture)?;
    Ok(refine(
        &picture,
        &people,
        prev,
        &Cut::default(),
        None,
        &mut Chosen::default(),
    ))
}

/// How much of a person each point of the model's picture is.
fn rough(net: &mut Engine, picture: &[[f32; 3]]) -> anyhow::Result<Vec<f32>> {
    // The model's picture: RGB from 0 to 1, colour by colour.
    let small = shrink_rgb(picture, W, H, IN_W, IN_H);
    let n = IN_W * IN_H;
    let mut x = vec![0f32; 3 * n];
    for (i, p) in small.iter().enumerate() {
        x[i] = p[0];
        x[n + i] = p[1];
        x[2 * n + i] = p[2];
    }
    let people = net.run(x, IN_W, IN_H)?;
    if people.len() != n {
        anyhow::bail!("the model gave {} points", people.len());
    }
    Ok(people)
}

/// The people's edges laid on those of the picture, steadied where they
/// only flicker since `prev` (where an edge moves, as found: no trail), kept
/// to what was painted when it is chosen (`camera`: where the picture was
/// taken from), then worked as `cut` says. The mask before that is given
/// back for the next one.
fn refine(
    picture: &[[f32; 3]],
    people: &[f32],
    prev: Option<&[f32]>,
    cut: &Cut,
    camera: Option<&CameraSample>,
    chosen: &mut Chosen,
) -> (Found, Vec<f32>) {
    let guide: Vec<f32> = picture
        .iter()
        .map(|p| 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2])
        .collect();
    let rough = stretch(people, IN_W, IN_H, W, H);
    let mut mask = guided(&guide, &rough, W, H, 4, 1e-3);
    // Steadied: at 60, half the one before where they differ by less than 0.2.
    let steady = cut.steady.clamp(0.0, 100.0);
    if let Some(prev) = prev.filter(|p| p.len() == mask.len() && steady > 0.0) {
        let (near, k) = (steady / 300.0, (steady / 120.0).min(0.85));
        for (m, p) in mask.iter_mut().zip(prev) {
            if (*m - p).abs() < near {
                *m += (p - *m) * k;
            }
        }
    }
    let worked = match cut.foreground {
        Foreground::All => {
            *chosen = Chosen::default();
            work(&mask, cut)
        }
        Foreground::Chosen => work(&chosen.pick(&guide, &mask, &cut.strokes, camera), cut),
    };
    let data = worked
        .iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();
    (
        Found {
            width: W as u32,
            height: H as u32,
            data,
        },
        mask,
    )
}

/// The mask as the camera's settings say: its edge moved, made sharper or
/// softer.
fn work(mask: &[f32], cut: &Cut) -> Vec<f32> {
    let mut m: Vec<f32> = mask.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    // Contour: points of a 1920-wide picture, at this size.
    let by = cut.contour.clamp(-10.0, 10.0) * W as f32 / 1920.0;
    if by.abs() > 0.01 {
        m = grown(&m, W, H, by);
    }
    let edge = cut.edge.clamp(0.0, 100.0);
    if edge < 40.0 {
        // Sharper: the half way point stays, the slope steepens.
        let w = 0.08 + 0.92 * edge / 40.0;
        for v in &mut m {
            *v = ((*v - 0.5) / w + 0.5).clamp(0.0, 1.0);
        }
    } else if edge > 40.0 {
        let r = ((edge - 40.0) / 60.0 * 4.0).round() as usize;
        if r > 0 {
            m = boxed(&m, W, H, r);
        }
    }
    m
}

/// What the strokes chose, from picture to picture.
#[derive(Default)]
struct Chosen {
    /// Whether each stroke was painted on a person, by its print, as first seen.
    on_person: HashMap<u64, bool>,
    /// The people kept in the picture before, grown a little: which one each point is (0: none).
    people: Vec<u32>,
    /// The prints of the strokes that chose each of them.
    chose: Vec<BTreeSet<u64>>,
    /// For the page.
    items: Vec<Item>,
}

/// How far the people kept are looked for in the next picture, points.
const FOLLOWED: f32 = 6.0;
/// How far around a person kept their soft edge is kept, points.
const AROUND: f32 = 3.0;
/// No stroke there.
const NONE: u32 = u32::MAX;

impl Chosen {
    /// The mask kept to what the strokes chose (seen from `camera`): the
    /// people they touch or touched, the objects painted, their edges laid
    /// on those of the picture (`guide`).
    fn pick(
        &mut self,
        guide: &[f32],
        mask: &[f32],
        strokes: &[Stroke],
        camera: Option<&CameraSample>,
    ) -> Vec<f32> {
        let n = W * H;
        let prints: Vec<u64> = strokes.iter().map(print).collect();
        let covered: Vec<Vec<u32>> = strokes.iter().map(|s| raster(s, camera)).collect();
        let person: Vec<bool> = mask.iter().map(|v| *v > 0.5).collect();
        // What each stroke was painted on, as first seen.
        self.on_person.retain(|p, _| prints.contains(p));
        for ((s, p), c) in strokes.iter().zip(&prints).zip(&covered) {
            if !s.erase && !c.is_empty() && !self.on_person.contains_key(p) {
                let on = c.iter().filter(|i| person[**i as usize]).count();
                self.on_person.insert(*p, on * 2 >= c.len());
            }
        }
        let is_person: Vec<bool> = strokes
            .iter()
            .zip(&prints)
            .map(|(s, p)| !s.erase && self.on_person.get(p) == Some(&true))
            .collect();
        // The stroke seen at each point (none where erased).
        let mut top = vec![NONE; n];
        for (k, (s, c)) in strokes.iter().zip(&covered).enumerate() {
            let v = if s.erase { NONE } else { k as u32 };
            for i in c {
                top[*i as usize] = v;
            }
        }
        let mut seen = vec![0usize; strokes.len()];
        for k in top.iter().filter(|k| **k != NONE) {
            seen[*k as usize] += 1;
        }
        // Rubbed out entirely (out of the picture is not).
        let erased = |k: usize| !covered[k].is_empty() && seen[k] == 0;
        let painted: BTreeSet<u64> = (0..strokes.len())
            .filter(|k| is_person[*k] && !erased(*k))
            .map(|k| prints[k])
            .collect();

        // The people: those a stroke on a person touches, and those kept
        // before that they overlap.
        let (part, count) = parts(&person, W, H);
        let mut chose = vec![BTreeSet::<u64>::new(); count as usize + 1];
        let mut was = BTreeSet::new();
        for i in 0..n {
            let c = part[i] as usize;
            if c == 0 {
                continue;
            }
            let k = top[i];
            if k != NONE && is_person[k as usize] {
                chose[c].insert(prints[k as usize]);
            }
            if let Some(b) = self.people.get(i).filter(|b| **b != 0) {
                was.insert((c, *b as usize - 1));
            }
        }
        for (c, b) in was {
            if let Some(before) = self.chose.get(b) {
                chose[c].extend(before.intersection(&painted).copied());
            }
        }
        let mut kept = vec![0u32; count as usize + 1];
        let mut sets = Vec::new();
        for (c, set) in chose.into_iter().enumerate().skip(1) {
            if !set.is_empty() {
                sets.push(set);
                kept[c] = sets.len() as u32;
            }
        }
        let labels: Vec<f32> = part.iter().map(|c| kept[*c as usize] as f32).collect();
        let member: Vec<f32> = labels.iter().map(|l| l.min(1.0)).collect();
        let near = grown(&member, W, H, AROUND);
        let mut out: Vec<f32> = mask.iter().zip(&near).map(|(m, k)| m * k).collect();
        self.people = grown(&labels, W, H, FOLLOWED)
            .iter()
            .map(|l| l.round() as u32)
            .collect();

        // The objects: what is painted off the people, its edges laid on the picture's.
        let mut objects = vec![0f32; n];
        let mut any = false;
        for (i, o) in objects.iter_mut().enumerate() {
            let k = top[i];
            if k != NONE && !is_person[k as usize] && !person[i] {
                *o = 1.0;
                any = true;
            }
        }
        // The strokes of each person kept, and of each object found, go together.
        let mut together: Vec<Vec<usize>> = sets
            .iter()
            .map(|set| {
                (0..strokes.len())
                    .filter(|k| set.contains(&prints[*k]))
                    .collect()
            })
            .collect();
        if any {
            let laid = guided(guide, &objects, W, H, 16, 1e-3);
            for (o, v) in objects.iter_mut().zip(laid) {
                let s = ((v - 0.35) / 0.3).clamp(0.0, 1.0);
                *o = s * s * (3.0 - 2.0 * s);
            }
            for (o, v) in out.iter_mut().zip(&objects) {
                *o = o.max(*v);
            }
            let found: Vec<bool> = objects.iter().map(|v| *v > 0.5).collect();
            let (part, count) = parts(&found, W, H);
            let mut of = vec![Vec::new(); count as usize + 1];
            for (k, c) in covered.iter().enumerate() {
                if strokes[k].erase || is_person[k] {
                    continue;
                }
                let mut most: HashMap<u32, usize> = HashMap::new();
                for i in c.iter().filter(|i| top[**i as usize] == k as u32) {
                    *most.entry(part[*i as usize]).or_default() += 1;
                }
                let best = most
                    .into_iter()
                    .filter(|(p, _)| *p != 0)
                    .max_by_key(|(p, m)| (*m, std::cmp::Reverse(*p)));
                if let Some((p, _)) = best {
                    of[p as usize].push(k);
                }
            }
            together.extend(of.into_iter().filter(|ks| ks.len() > 1));
        }

        self.items = items(strokes, &covered, &is_person, &together, &erased);
        self.chose = sets;
        out
    }
}

/// What the page lists: the strokes that touch (of a kind), those `together`
/// (on the same person or object), each eraser with the paint it rubs out most.
fn items(
    strokes: &[Stroke],
    covered: &[Vec<u32>],
    is_person: &[bool],
    together: &[Vec<usize>],
    erased: &dyn Fn(usize) -> bool,
) -> Vec<Item> {
    let mut up: Vec<usize> = (0..strokes.len()).collect();
    fn root(up: &mut [usize], mut k: usize) -> usize {
        while up[k] != k {
            up[k] = up[up[k]];
            k = up[k];
        }
        k
    }
    fn join(up: &mut [usize], a: usize, b: usize) {
        let (a, b) = (root(up, a), root(up, b));
        up[a.max(b)] = a.min(b);
    }
    let n = W * H;
    let (mut first_person, mut first_object, mut last) =
        (vec![NONE; n], vec![NONE; n], vec![NONE; n]);
    for (k, (s, c)) in strokes.iter().zip(covered).enumerate() {
        if s.erase {
            let mut rubbed: HashMap<u32, usize> = HashMap::new();
            for i in c {
                let j = last[*i as usize];
                if j != NONE {
                    *rubbed.entry(j).or_default() += 1;
                }
            }
            if let Some((j, _)) = rubbed
                .into_iter()
                .max_by_key(|(j, m)| (*m, std::cmp::Reverse(*j)))
            {
                join(&mut up, k, j as usize);
            }
            continue;
        }
        let first = if is_person[k] {
            &mut first_person
        } else {
            &mut first_object
        };
        for i in c {
            let i = *i as usize;
            if first[i] == NONE {
                first[i] = k as u32;
            } else {
                join(&mut up, k, first[i] as usize);
            }
            last[i] = k as u32;
        }
    }
    for ks in together {
        for w in ks.windows(2) {
            join(&mut up, w[0], w[1]);
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for k in 0..strokes.len() {
        let r = root(&mut up, k);
        groups.entry(r).or_default().push(k);
    }
    let mut out: Vec<Item> = groups
        .into_values()
        .filter(|g| g.iter().any(|k| !strokes[*k].erase && !erased(*k)))
        .map(|g| Item {
            kind: if g.iter().any(|k| is_person[*k]) {
                Kind::Person
            } else {
                Kind::Object
            },
            strokes: g,
        })
        .collect();
    out.sort_by_key(|i| (i.kind == Kind::Object, i.strokes[0]));
    out
}

/// A stroke's print: the same stroke has the same, wherever it is in the list.
fn print(s: &Stroke) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.erase.hash(&mut h);
    s.size.to_bits().hash(&mut h);
    for p in &s.points {
        p[0].to_bits().hash(&mut h);
        p[1].to_bits().hash(&mut h);
    }
    h.finish()
}

/// The points of the picture (`W` × `H`) a stroke covers, seen from
/// `camera` (where its anchor is seen now; as painted without either).
fn raster(s: &Stroke, camera: Option<&CameraSample>) -> Vec<u32> {
    let (w, h) = (W as f64, H as f64);
    let radius = s.size.max(0.0) as f64 * w / 2.0;
    let at: Vec<[f64; 3]> = s
        .points
        .iter()
        .filter_map(|p| {
            let (x, y) = (p[0] as f64 * w, p[1] as f64 * h);
            match (&s.anchor, camera) {
                (Some(a), Some(c)) => {
                    follow(a, c, w, h, x, y).map(|(dx, dy, k)| [x + dx, y + dy, radius * k])
                }
                _ => Some([x, y, radius]),
            }
        })
        .collect();
    let mut on = vec![false; W * H];
    let mut out = Vec::new();
    let mut segment = |a: [f64; 3], b: [f64; 3]| {
        let r = a[2].max(b[2]).max(0.5);
        let x0 = (a[0].min(b[0]) - r).floor().max(0.0) as usize;
        let y0 = (a[1].min(b[1]) - r).floor().max(0.0) as usize;
        let x1 = ((a[0].max(b[0]) + r).ceil().min(w - 1.0)).max(-1.0);
        let y1 = ((a[1].max(b[1]) + r).ceil().min(h - 1.0)).max(-1.0);
        if x1 < 0.0 || y1 < 0.0 {
            return;
        }
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = dx * dx + dy * dy;
        for y in y0..=y1 as usize {
            for x in x0..=x1 as usize {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                let t = if len > 0.0 {
                    (((px - a[0]) * dx + (py - a[1]) * dy) / len).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let (cx, cy) = (a[0] + dx * t, a[1] + dy * t);
                let rt = (a[2] + (b[2] - a[2]) * t).max(0.5);
                let i = y * W + x;
                if !on[i] && (px - cx).powi(2) + (py - cy).powi(2) <= rt * rt {
                    on[i] = true;
                    out.push(i as u32);
                }
            }
        }
    };
    match at.as_slice() {
        [] => {}
        [p] => segment(*p, *p),
        many => {
            for pair in many.windows(2) {
                segment(pair[0], pair[1]);
            }
        }
    }
    out
}

/// The parts of `on` that touch (four ways): which one each point is (0:
/// none), and how many there are.
fn parts(on: &[bool], w: usize, h: usize) -> (Vec<u32>, u32) {
    let mut label = vec![0u32; w * h];
    let mut n = 0;
    let mut stack = Vec::new();
    for i in 0..w * h {
        if !on[i] || label[i] != 0 {
            continue;
        }
        n += 1;
        label[i] = n;
        stack.push(i);
        while let Some(j) = stack.pop() {
            let (x, y) = (j % w, j / w);
            let near = [
                (x > 0).then(|| j - 1),
                (x + 1 < w).then(|| j + 1),
                (y > 0).then(|| j - w),
                (y + 1 < h).then(|| j + w),
            ];
            for k in near.into_iter().flatten() {
                if on[k] && label[k] == 0 {
                    label[k] = n;
                    stack.push(k);
                }
            }
        }
    }
    (label, n)
}

/// The mask grown (`by` > 0) or shrunk by `by` points: the largest (or
/// smallest) value around each point, between two whole sizes.
fn grown(m: &[f32], w: usize, h: usize, by: f32) -> Vec<f32> {
    let r = by.abs();
    let (lo, k) = (r.floor() as usize, r.fract());
    let pick = |a: f32, b: f32| if by > 0.0 { a.max(b) } else { a.min(b) };
    let around = |r: usize| -> Vec<f32> {
        if r == 0 {
            return m.to_vec();
        }
        let mut rows = vec![0f32; w * h];
        for (src, out) in m.chunks_exact(w).zip(rows.chunks_exact_mut(w)) {
            for (x, o) in out.iter_mut().enumerate() {
                *o = src[x.saturating_sub(r)..(x + r + 1).min(w)]
                    .iter()
                    .copied()
                    .reduce(pick)
                    .unwrap_or(0.0);
            }
        }
        let mut out = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                out[y * w + x] = (y.saturating_sub(r)..(y + r + 1).min(h))
                    .map(|yy| rows[yy * w + x])
                    .reduce(pick)
                    .unwrap_or(0.0);
            }
        }
        out
    };
    let a = around(lo);
    if k < 0.01 {
        return a;
    }
    let b = around(lo + 1);
    a.iter().zip(&b).map(|(a, b)| a + (b - a) * k).collect()
}

/// A picture made smaller (each point the average of those it covers), RGB from 0 to 1.
fn shrink(pic: &Pixmap, w: usize, h: usize) -> Vec<[f32; 3]> {
    let (sw, sh) = (pic.width() as usize, pic.height() as usize);
    let src = pic.data();
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        let (y0, y1) = (y * sh / h, ((y + 1) * sh / h).max(y * sh / h + 1).min(sh));
        for x in 0..w {
            let (x0, x1) = (x * sw / w, ((x + 1) * sw / w).max(x * sw / w + 1).min(sw));
            // Every other point of a large block is enough.
            let step = if y1 - y0 >= 4 && x1 - x0 >= 4 { 2 } else { 1 };
            let (mut sum, mut n) = ([0u32; 3], 0u32);
            for yy in (y0..y1).step_by(step) {
                let row = &src[(yy * sw + x0) * 4..(yy * sw + x1) * 4];
                for p in row.as_chunks::<4>().0.iter().step_by(step) {
                    sum[0] += p[0] as u32;
                    sum[1] += p[1] as u32;
                    sum[2] += p[2] as u32;
                    n += 1;
                }
            }
            let k = 1.0 / (255.0 * n.max(1) as f32);
            out.push([sum[0] as f32 * k, sum[1] as f32 * k, sum[2] as f32 * k]);
        }
    }
    out
}

/// The same, from a picture already made smaller.
fn shrink_rgb(src: &[[f32; 3]], sw: usize, sh: usize, w: usize, h: usize) -> Vec<[f32; 3]> {
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        let (y0, y1) = (y * sh / h, ((y + 1) * sh / h).max(y * sh / h + 1).min(sh));
        for x in 0..w {
            let (x0, x1) = (x * sw / w, ((x + 1) * sw / w).max(x * sw / w + 1).min(sw));
            let mut sum = [0f32; 3];
            for yy in y0..y1 {
                for p in &src[yy * sw + x0..yy * sw + x1] {
                    sum[0] += p[0];
                    sum[1] += p[1];
                    sum[2] += p[2];
                }
            }
            let k = 1.0 / ((y1 - y0) * (x1 - x0)) as f32;
            out.push([sum[0] * k, sum[1] * k, sum[2] * k]);
        }
    }
    out
}

/// Values stretched to `w` × `h` (between the four points around).
fn stretch(src: &[f32], sw: usize, sh: usize, w: usize, h: usize) -> Vec<f32> {
    // Each column: the two points it falls between, and how far.
    let cols: Vec<(usize, usize, f32)> = (0..w)
        .map(|x| {
            let fx = ((x as f32 + 0.5) * sw as f32 / w as f32 - 0.5).clamp(0.0, (sw - 1) as f32);
            let x0 = fx as usize;
            (x0, (x0 + 1).min(sw - 1), fx - x0 as f32)
        })
        .collect();
    let mut out = vec![0f32; w * h];
    let mut row = vec![0f32; sw];
    for (y, line) in out.chunks_exact_mut(w).enumerate() {
        let fy = ((y as f32 + 0.5) * sh as f32 / h as f32 - 0.5).clamp(0.0, (sh - 1) as f32);
        let y0 = fy as usize;
        let (ky, y1) = (fy - y0 as f32, (y0 + 1).min(sh - 1));
        let (a, b) = (&src[y0 * sw..(y0 + 1) * sw], &src[y1 * sw..(y1 + 1) * sw]);
        for ((r, a), b) in row.iter_mut().zip(a).zip(b) {
            *r = a + (b - a) * ky;
        }
        for (o, (x0, x1, kx)) in line.iter_mut().zip(&cols) {
            *o = row[*x0] + (row[*x1] - row[*x0]) * kx;
        }
    }
    out
}

/// The average of the points within `r` of each one (fewer at the borders):
/// sums sliding along the rows, then down the columns.
fn boxed(a: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut rows = vec![0f32; w * h];
    for (src, out) in a.chunks_exact(w).zip(rows.chunks_exact_mut(w)) {
        let mut sum: f32 = src[..(r + 1).min(w)].iter().sum();
        for x in 0..w {
            out[x] = sum;
            if x + r + 1 < w {
                sum += src[x + r + 1];
            }
            if x >= r {
                sum -= src[x - r];
            }
        }
    }
    let span = |i: usize, n: usize| ((i + r + 1).min(n) - i.saturating_sub(r)) as f32;
    let across: Vec<f32> = (0..w).map(|x| 1.0 / span(x, w)).collect();
    let mut column = vec![0f32; w];
    for row in rows.chunks_exact(w).take(r + 1) {
        for (c, v) in column.iter_mut().zip(row) {
            *c += v;
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let down = 1.0 / span(y, h);
        for ((o, c), k) in out[y * w..(y + 1) * w].iter_mut().zip(&column).zip(&across) {
            *o = c * k * down;
        }
        if y + r + 1 < h {
            for (c, v) in column
                .iter_mut()
                .zip(&rows[(y + r + 1) * w..(y + r + 2) * w])
            {
                *c += v;
            }
        }
        if y >= r {
            for (c, v) in column.iter_mut().zip(&rows[(y - r) * w..(y - r + 1) * w]) {
                *c -= v;
            }
        }
    }
    out
}

/// He, Sun and Tang's guided filter: `p` smoothed, its edges following those of `guide`.
fn guided(guide: &[f32], p: &[f32], w: usize, h: usize, r: usize, eps: f32) -> Vec<f32> {
    let mul = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(a, b)| a * b).collect::<Vec<_>>();
    let mean_i = boxed(guide, w, h, r);
    let mean_p = boxed(p, w, h, r);
    let corr_ip = boxed(&mul(guide, p), w, h, r);
    let corr_ii = boxed(&mul(guide, guide), w, h, r);
    let mut a = Vec::with_capacity(w * h);
    let mut b = Vec::with_capacity(w * h);
    for i in 0..w * h {
        let var = corr_ii[i] - mean_i[i] * mean_i[i];
        let cov = corr_ip[i] - mean_i[i] * mean_p[i];
        let ai = cov / (var + eps);
        a.push(ai);
        b.push(mean_p[i] - ai * mean_i[i]);
    }
    let (ma, mb) = (boxed(&a, w, h, r), boxed(&b, w, h, r));
    (0..w * h).map(|i| ma[i] * guide[i] + mb[i]).collect()
}

/// `PUT /api/inputs/<id>/cut`: the camera's people cut out so from now on
/// (the settings keep them once saved), 404 when its people are not found.
pub async fn try_cut(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    UrlPath(id): UrlPath<String>,
    Json(cut): Json<Cut>,
) -> StatusCode {
    if !me.is_admin() {
        return StatusCode::FORBIDDEN;
    }
    if s.people.try_cut(&id, cut) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

#[derive(Deserialize)]
pub struct PreviewQuery {
    /// The number of the picture the page has: 204 while there is no newer one.
    #[serde(default)]
    after: Option<u64>,
    #[serde(default)]
    view: View,
}

/// `GET /api/inputs/<id>/people.jpg?after=<n>`: the tracked camera's newest
/// picture with its people shown (`X-Frame`: its number), 204 when there is
/// none or nothing newer. Asking finds the people a few seconds.
pub async fn preview(
    State(s): State<Shared>,
    MaybeUser(me): MaybeUser,
    UrlPath(id): UrlPath<String>,
    Query(q): Query<PreviewQuery>,
) -> Response {
    if me.is_none() {
        return (StatusCode::UNAUTHORIZED, "sign in").into_response();
    }
    let (people, inputs) = (s.people.clone(), s.inputs.clone());
    let shot = tokio::task::spawn_blocking(move || {
        let (n, pm) = people.preview(&id, &inputs, q.view)?;
        if q.after == Some(n) {
            return Some((n, None));
        }
        Some((n, cg_render::jpeg(&pm, W as u32, 78)))
    })
    .await
    .ok()
    .flatten();
    let frame = |r: &mut Response, n: u64| {
        if let Ok(v) = n.to_string().parse() {
            r.headers_mut().insert("x-frame", v);
        }
    };
    match shot {
        Some((n, Some(jpeg))) => {
            let mut r = (
                [
                    (header::CONTENT_TYPE, "image/jpeg"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                jpeg,
            )
                .into_response();
            frame(&mut r, n);
            r
        }
        other => {
            let mut r = (
                StatusCode::NO_CONTENT,
                [(header::CACHE_CONTROL, "no-store")],
            )
                .into_response();
            if let Some((n, _)) = other {
                frame(&mut r, n);
            }
            r
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The astronaut of the public-domain NASA portrait (Eileen Collins),
    /// at the model's size.
    fn portrait() -> Pixmap {
        let img = image::load_from_memory(include_bytes!("../tests/fixtures/people.jpg"))
            .unwrap()
            .to_rgba8();
        let (w, h) = img.dimensions();
        Pixmap::from_vec(img.into_raw(), IntSize::from_wh(w, h).unwrap()).unwrap()
    }

    #[test]
    fn the_people_are_found_and_the_rest_is_not() {
        let mut net = Engine::new(MODEL, IN_W, IN_H, Processor::Cpu).expect("the model is read");
        let (found, _) = find(&mut net, &portrait(), None).unwrap();
        assert_eq!((found.width, found.height), (W as u32, H as u32));
        // Her face and her suit; the wall behind her.
        let at = |u: f64, v: f64| found.at(u, v);
        assert!(at(0.44, 0.38) > 200.0, "face: {}", at(0.44, 0.38));
        assert!(at(0.22, 0.92) > 200.0, "suit: {}", at(0.22, 0.92));
        assert!(at(0.68, 0.12) < 40.0, "wall: {}", at(0.68, 0.12));
    }

    #[test]
    fn the_guided_filter_keeps_a_flat_picture_flat() {
        let (w, h) = (20, 10);
        let guide = vec![0.5; w * h];
        let p: Vec<f32> = (0..w * h)
            .map(|i| if i % w < 10 { 1.0 } else { 0.0 })
            .collect();
        let q = guided(&guide, &p, w, h, 2, 1e-3);
        // Far from the edge: as it was.
        assert!((q[5 * w + 1] - 1.0).abs() < 1e-3);
        assert!(q[5 * w + 18].abs() < 1e-3);
    }

    #[test]
    fn the_box_average_counts_the_points_around() {
        let (w, h, r) = (13, 7, 3);
        let a: Vec<f32> = (0..w * h).map(|i| ((i * 37) % 11) as f32 / 10.0).collect();
        let fast = boxed(&a, w, h, r);
        for y in 0..h {
            for x in 0..w {
                let (mut sum, mut n) = (0.0, 0.0);
                for yy in y.saturating_sub(r)..(y + r + 1).min(h) {
                    for xx in x.saturating_sub(r)..(x + r + 1).min(w) {
                        sum += a[yy * w + xx];
                        n += 1.0;
                    }
                }
                assert!((fast[y * w + x] - sum / n).abs() < 1e-5, "({x}, {y})");
            }
        }
    }

    #[test]
    fn a_frame_takes_the_people_of_its_picture() {
        let cam = Cam::new("sdi-1", Cut::default());
        *lock(&cam.period) = 0.02;
        cam.delay.store(4, Ordering::Relaxed);
        let t0 = Instant::now();
        for i in 0..10u8 {
            let f = Found {
                width: 1,
                height: 1,
                data: vec![i],
            };
            lock(&cam.found).push_back((t0 + Duration::from_millis(20 * i as u64), Arc::new(f)));
        }
        // Shown at picture 9's time: the picture of 4 frames before, come a frame later (6).
        let f = cam.for_frame(t0 + Duration::from_millis(180)).unwrap();
        assert_eq!(f.data[0], 6);
        // Long after the last picture: nobody.
        assert!(cam.for_frame(t0 + Duration::from_secs(5)).is_none());
    }

    #[test]
    fn the_delay_counts_the_picture_finding_and_drawing_ahead() {
        let cam = Cam::new("sdi-1", Cut::default());
        *lock(&cam.period) = 0.02;
        // Drawn two frames ahead, 12 ms a picture: 1 + ceil((40 + 12) / 20) = 4.
        *lock(&cam.lead) = 0.04;
        lock(&cam.took).extend([12.0; 20]);
        cam.update_delay();
        assert_eq!(cam.delay(), 4);
        // Faster afterwards: the mixer keeps its setting.
        lock(&cam.took).clear();
        lock(&cam.took).extend([2.0; 20]);
        cam.update_delay();
        assert_eq!(cam.delay(), 4);
    }

    fn stroke(points: &[[f32; 2]], size: f32) -> Stroke {
        Stroke {
            erase: false,
            size,
            points: points.to_vec(),
            anchor: None,
        }
    }

    /// The middle of the points a stroke covers.
    fn middle(c: &[u32]) -> (f64, f64) {
        let n = c.len() as f64;
        let x = c
            .iter()
            .map(|i| (*i as usize % W) as f64 + 0.5)
            .sum::<f64>()
            / n;
        let y = c
            .iter()
            .map(|i| (*i as usize / W) as f64 + 0.5)
            .sum::<f64>()
            / n;
        (x, y)
    }

    /// People where `boxes` are (x0, y0, x1, y1 in points), the rest none.
    fn people_in(boxes: &[(usize, usize, usize, usize)]) -> Vec<f32> {
        let mut m = vec![0f32; W * H];
        for &(x0, y0, x1, y1) in boxes {
            for y in y0..y1 {
                m[y * W + x0..y * W + x1].fill(1.0);
            }
        }
        m
    }

    #[test]
    fn a_stroke_stays_on_the_set_as_the_camera_pans() {
        use cg_core::tracking::{Track, SENSOR_MM};
        let anchor = Track {
            pan: 0.0,
            tilt: 0.0,
            roll: 0.0,
            focal: 35.0,
            sensor: SENSOR_MM,
            zoom: true,
            distance: 0.0,
            distortion: None,
            behind: false,
        };
        let s = Stroke {
            anchor: Some(anchor),
            ..stroke(&[[0.5, 0.5]], 0.04)
        };
        // As painted: a disc of 0.04 × 480 = 19 points across, in the middle.
        let here = raster(&s, None);
        let (x, y) = middle(&here);
        assert!(
            (x - 240.0).abs() < 0.5 && (y - 135.0).abs() < 0.5,
            "{x}, {y}"
        );
        assert!((here.len() as f64 - std::f64::consts::PI * 9.6 * 9.6).abs() < 20.0);
        // The camera turned 5° to its left: the set, and the stroke, go right.
        let cam = CameraSample {
            pan: 5.0,
            focal: 35.0,
            sensor: SENSOR_MM,
            ..Default::default()
        };
        let (x, y) = middle(&raster(&s, Some(&cam)));
        let want = 240.0 + 35.0 / SENSOR_MM * 480.0 * 5f64.to_radians().tan();
        assert!(
            (x - want).abs() < 0.5 && (y - 135.0).abs() < 0.5,
            "{x} for {want}"
        );
        // Painted without a camera: it stays where it was painted.
        let (x, _) = middle(&raster(&stroke(&[[0.5, 0.5]], 0.04), Some(&cam)));
        assert!((x - 240.0).abs() < 0.5);
    }

    #[test]
    fn a_person_touched_is_kept_and_followed() {
        let guide = vec![0.5; W * H];
        // Painted on the first one only.
        let strokes = [stroke(&[[125.0 / 480.0, 0.5], [127.0 / 480.0, 0.55]], 0.03)];
        let mut chosen = Chosen::default();
        let mut out = Vec::new();
        // She walks right, out of the paint; the other stays.
        for step in 0..40 {
            let x = 100 + 4 * step;
            let mask = people_in(&[(x, 60, x + 50, 270), (380, 60, 430, 270)]);
            out = chosen.pick(&guide, &mask, &strokes, None);
            assert!(out[150 * W + x + 25] > 0.99, "picture {step}");
            assert!(out[150 * W + 405] < 0.01, "picture {step}");
            assert_eq!(
                chosen.items,
                [Item {
                    kind: Kind::Person,
                    strokes: vec![0]
                }]
            );
        }
        // Where she stood is not an object.
        assert!(out[140 * W + 125] < 0.01);
        // Rubbed out: nobody.
        let mut rubbed = strokes.to_vec();
        rubbed.push(Stroke {
            erase: true,
            ..stroke(&[[126.0 / 480.0, 0.52]], 0.1)
        });
        let mask = people_in(&[(256, 60, 306, 270)]);
        let out = chosen.pick(&guide, &mask, &rubbed, None);
        assert!(out[150 * W + 280] < 0.01);
        assert!(chosen.items.is_empty());
    }

    #[test]
    fn a_rough_stroke_finds_the_edges_of_its_object() {
        // A light box (200..280 × 100..200) on a dark set; nobody.
        let guide: Vec<f32> = (0..W * H)
            .map(|i| {
                let (x, y) = (i % W, i / W);
                if (200..280).contains(&x) && (100..200).contains(&y) {
                    0.8
                } else {
                    0.15
                }
            })
            .collect();
        // Painted over it roughly: 6 points over on the sides, rounded corners.
        let (u, v) = (|x: f32| x / W as f32, |y: f32| y / H as f32);
        let strokes: Vec<Stroke> = [110.0, 130.0, 150.0, 170.0, 190.0]
            .iter()
            .map(|y| stroke(&[[u(204.0), v(*y)], [u(276.0), v(*y)]], 20.0 / W as f32))
            .collect();
        let mut chosen = Chosen::default();
        let out = chosen.pick(&guide, &vec![0.0; W * H], &strokes, None);
        let at = |x: usize, y: usize| out[y * W + x];
        assert!(at(240, 150) > 0.99);
        // Its edges, not the paint's.
        assert!(at(196, 150) < 0.1, "{}", at(196, 150));
        assert!(at(201, 150) > 0.9, "{}", at(201, 150));
        assert!(at(283, 150) < 0.1, "{}", at(283, 150));
        assert!(at(278, 150) > 0.9, "{}", at(278, 150));
        assert!(at(201, 101) > 0.5, "corner: {}", at(201, 101));
        assert!(at(240, 205) < 0.1, "{}", at(240, 205));
        assert_eq!(chosen.items.len(), 1);
        assert_eq!(chosen.items[0].kind, Kind::Object);
        assert_eq!(chosen.items[0].strokes, [0, 1, 2, 3, 4]);
    }

    #[test]
    fn by_default_everyone_is_cut() {
        // The zones of before are forgotten.
        let old: Cut = serde_json::from_str(
            r#"{"contour":0,"zonesOn":true,"zones":[{"x":0.1,"y":0,"w":0.3,"h":1}]}"#,
        )
        .unwrap();
        assert_eq!(old, Cut::default());
        assert_eq!(Cut::default().foreground, Foreground::All);
        // Strokes kept but everyone chosen: both people cut, as painted or not.
        let picture = vec![[0.5f32; 3]; W * H];
        let people = vec![0f32; IN_W * IN_H];
        let cut = Cut {
            strokes: vec![stroke(&[[0.25, 0.5]], 0.03)],
            ..Cut::default()
        };
        let (found, _) = refine(&picture, &people, None, &cut, None, &mut Chosen::default());
        let (plain, _) = refine(
            &picture,
            &people,
            None,
            &Cut::default(),
            None,
            &mut Chosen::default(),
        );
        assert_eq!(found, plain);
        let mask = people_in(&[(100, 60, 150, 270), (380, 60, 430, 270)]);
        assert_eq!(work(&mask, &cut), work(&mask, &Cut::default()));
        // Chosen: only the one painted.
        let mut chosen = Chosen::default();
        let out = chosen.pick(&vec![0.5; W * H], &mask, &cut.strokes, None);
        assert!(out[150 * W + 125] > 0.99 && out[150 * W + 405] < 0.01);
    }
}
