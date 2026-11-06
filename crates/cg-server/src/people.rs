//! The people a tracked camera sees, so that the layers anchored behind them
//! (`Track::behind`) are cut where they are.
//!
//! A tracking input given the video input bringing its picture (`image`)
//! has two threads finding the people in each picture: MediaPipe's selfie
//! segmenter (assets/models, Apache 2.0) run at 256 × 144 on the graphics
//! card or the processor (`crate::people_net`), its edges then laid on those
//! of the picture (guided filter at 480 × 270), steadied where they only
//! flicker, then worked as the camera's `Cut` says (contour, edge, zones). It works while a
//! project of a channel has a graphic behind the people on that camera, or
//! while its preview is looked at.
//!
//! The mixer keys Strata's fill and key over the camera as before; finding
//! the people takes time, so it delays the camera by `delay` frames, and
//! each frame shown at T is cut by the people of the camera's picture of
//! `delay` frames before T. The camera's tracking is late as much (the
//! anchored graphics stay on the delayed picture).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tiny_skia::{IntSize, Pixmap};

use cg_core::tracking::People as Found;

use crate::auth::{CurrentUser, MaybeUser};
use crate::inputs::{Cut, InputConfig, InputKind, Inputs};
use crate::people_net::{Device, Engine, Processor};
use crate::state::Shared;

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
    pub fn apply(&self, configs: &[InputConfig], inputs: &Arc<Inputs>) {
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
            let (c, inputs) = (cam.clone(), inputs.clone());
            let spawned = std::thread::Builder::new()
                .name(format!("cg-people-{id}"))
                .spawn(move || run(c, inputs));
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
        Some(Status {
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
}

/// One camera's threads, while its people are wanted: one finds them
/// roughly in each new picture, the other lays their edges on the
/// picture's meanwhile (two pictures at a time: 50 a second on a processor).
fn run(cam: Arc<Cam>, inputs: Arc<Inputs>) {
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
    for (n, r) in (1u64..).zip(pictures) {
        // Steadied with the picture before only when it came just before.
        let before = prev
            .as_ref()
            .filter(|(at, _)| r.came.saturating_duration_since(*at) < Duration::from_millis(200))
            .map(|(_, m)| m.as_slice());
        let cut = lock(&cam.cut).clone();
        let (found, mask) = refine(&r.picture, &r.people, before, &cut);
        prev = Some((r.came, mask));
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
    Ok(refine(&picture, &people, prev, &Cut::default()))
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
/// only flicker since `prev` (where an edge moves, as found: no trail), then
/// worked as `cut` says. The mask before that is given back for the next one.
fn refine(
    picture: &[[f32; 3]],
    people: &[f32],
    prev: Option<&[f32]>,
    cut: &Cut,
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
    let worked = work(&mask, cut);
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
/// softer, kept in the zones.
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
    let zones: Vec<_> = cut
        .zones
        .iter()
        .filter(|z| z.w > 0.0 && z.h > 0.0)
        .collect();
    if cut.zones_on && !zones.is_empty() {
        for (i, v) in m.iter_mut().enumerate() {
            let (u, t) = (
                ((i % W) as f32 + 0.5) / W as f32,
                ((i / W) as f32 + 0.5) / H as f32,
            );
            if !zones
                .iter()
                .any(|z| u >= z.x && u <= z.x + z.w && t >= z.y && t <= z.y + z.h)
            {
                *v = 0.0;
            }
        }
    }
    m
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
}
