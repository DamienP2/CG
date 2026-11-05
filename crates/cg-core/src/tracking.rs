//! Camera tracking: graphics anchored to the scene follow the camera that
//! films it (mirror of web/src/engine/tracking.ts).
//!
//! A sample is the camera's orientation and lens as OpenTrackIO gives them:
//! Z up, right-handed, Y forward at rest, X to the camera's right; pan,
//! tilt and roll in degrees, intrinsic about Z, X then Y. A layer anchored
//! with [`Track`] (`Layer::anchor`) keeps the direction its anchor point was seen in when it
//! was anchored: as the camera turns and zooms, the point goes where that
//! direction is now seen. A layer anchored at a distance (an object near
//! the camera) is a point of the scene instead: the optical centre, ahead
//! of the pan and tilt axes, moves as the camera turns, and the point is
//! seen from there (parallax). The lens distortion the camera sends is
//! taken out of the anchored picture and put back into the new one.

use serde::{Deserialize, Serialize};

/// The width of the FR7's full-frame sensor (16:9 area), when the camera
/// does not tell its own.
pub const SENSOR_MM: f64 = 35.6;
/// The focal length assumed when the camera does not tell it.
pub const FOCAL_MM: f64 = 35.0;

/// Where a camera looks and how it is zoomed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSample {
    /// Degrees.
    pub pan: f64,
    pub tilt: f64,
    pub roll: f64,
    /// Focal length, mm (0: unknown).
    #[serde(default)]
    pub focal: f64,
    /// Width of the sensor's active area, mm (0: unknown).
    #[serde(default)]
    pub sensor: f64,
    /// Focus distance, m (0: unknown).
    #[serde(default)]
    pub focus: f64,
    /// f-number (0: unknown).
    #[serde(default)]
    pub iris: f64,
    /// Position on the stage, m.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub z: f64,
    /// The lens distortion, when the camera sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distortion: Option<Distortion>,
    /// How far ahead of the pan and tilt axes the optical centre is, m.
    #[serde(default)]
    pub pupil: f64,
    /// The camera sent the optical centre (else the input's setting).
    #[serde(default, skip_serializing_if = "is_false")]
    pub pupil_sent: bool,
    /// The camera sent its sensor's width.
    #[serde(default, skip_serializing_if = "is_false")]
    pub sensor_sent: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A lens distortion (Brown-Conrady): radial k1..k3 and tangential p1, p2,
/// on picture coordinates divided by the focal length (in pixels).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Distortion {
    #[serde(default)]
    pub k1: f64,
    #[serde(default)]
    pub k2: f64,
    #[serde(default)]
    pub k3: f64,
    #[serde(default)]
    pub p1: f64,
    #[serde(default)]
    pub p2: f64,
    /// The coefficients take the distorted picture to the undistorted one
    /// (OpenTrackIO's "D-U"); else the reverse ("U-D").
    #[serde(default)]
    pub to_undistorted: bool,
}

impl Distortion {
    /// The polynomial.
    fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let r2 = x * x + y * y;
        let k = 1.0 + r2 * (self.k1 + r2 * (self.k2 + r2 * self.k3));
        (
            x * k + 2.0 * self.p1 * x * y + self.p2 * (r2 + 2.0 * x * x),
            y * k + self.p1 * (r2 + 2.0 * y * y) + 2.0 * self.p2 * x * y,
        )
    }

    /// The point the polynomial takes to (`x`, `y`).
    fn solve(&self, x: f64, y: f64) -> (f64, f64) {
        let (mut u, mut v) = (x, y);
        for _ in 0..20 {
            let (a, b) = self.apply(u, v);
            u += x - a;
            v += y - b;
        }
        (u, v)
    }

    /// Where a point of the distorted picture is without distortion.
    pub fn undistort(&self, x: f64, y: f64) -> (f64, f64) {
        if self.to_undistorted {
            self.apply(x, y)
        } else {
            self.solve(x, y)
        }
    }

    /// Where a point without distortion is in the distorted picture.
    pub fn distort(&self, x: f64, y: f64) -> (f64, f64) {
        if self.to_undistorted {
            self.solve(x, y)
        } else {
            self.apply(x, y)
        }
    }
}

/// A layer anchored to the scene: the camera as it was when it was anchored.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub pan: f64,
    pub tilt: f64,
    #[serde(default)]
    pub roll: f64,
    #[serde(default)]
    pub focal: f64,
    #[serde(default)]
    pub sensor: f64,
    /// Its size follows the zoom.
    #[serde(default)]
    pub zoom: bool,
    /// How far it is from the camera, m (0: far away, its direction only).
    #[serde(default)]
    pub distance: f64,
    /// The lens distortion when it was anchored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distortion: Option<Distortion>,
    /// Cut where the camera sees people: it passes behind them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub behind: bool,
}

/// The people a camera sees, found in its picture: how much of a person
/// each point is (0 to 255), for the layers that pass behind them
/// ([`Track::behind`]). It covers the whole picture, whatever its size.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct People {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl People {
    /// How much of a person there is at `(u, v)` of the picture (0 to 1
    /// across it), between the four points around (0 to 255).
    pub fn at(&self, u: f64, v: f64) -> f64 {
        let (w, h) = (self.width as usize, self.height as usize);
        if w == 0 || h == 0 || self.data.len() < w * h {
            return 0.0;
        }
        let x = (u * w as f64 - 0.5).clamp(0.0, (w - 1) as f64);
        let y = (v * h as f64 - 0.5).clamp(0.0, (h - 1) as f64);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (fx, fy) = (x - x0 as f64, y - y0 as f64);
        let p = |x: usize, y: usize| self.data[y * w + x] as f64;
        let top = p(x0, y0) + (p(x1, y0) - p(x0, y0)) * fx;
        let bottom = p(x0, y1) + (p(x1, y1) - p(x0, y1)) * fx;
        top + (bottom - top) * fy
    }
}

/// The camera `k` of the way from `a` to `b` (beyond 1: on past `b` at the
/// same pace); angles the short way round.
pub fn mix(a: &CameraSample, b: &CameraSample, k: f64) -> CameraSample {
    let lin = |x: f64, y: f64| x + (y - x) * k;
    let ang = |x: f64, y: f64| x + ((y - x + 540.0).rem_euclid(360.0) - 180.0) * k;
    CameraSample {
        pan: ang(a.pan, b.pan),
        tilt: ang(a.tilt, b.tilt),
        roll: ang(a.roll, b.roll),
        focal: lin(a.focal, b.focal),
        sensor: b.sensor,
        focus: lin(a.focus, b.focus),
        iris: lin(a.iris, b.iris),
        x: lin(a.x, b.x),
        y: lin(a.y, b.y),
        z: lin(a.z, b.z),
        ..*b
    }
}

type M3 = [[f64; 3]; 3];

fn mul(a: &M3, b: &M3) -> M3 {
    let mut m = [[0.0; 3]; 3];
    for (i, row) in m.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    m
}

/// The camera's orientation: Rz(pan) · Rx(tilt) · Ry(roll).
fn rotation(pan: f64, tilt: f64, roll: f64) -> M3 {
    let (sp, cp) = pan.to_radians().sin_cos();
    let (st, ct) = tilt.to_radians().sin_cos();
    let (sr, cr) = roll.to_radians().sin_cos();
    let z = [[cp, -sp, 0.0], [sp, cp, 0.0], [0.0, 0.0, 1.0]];
    let x = [[1.0, 0.0, 0.0], [0.0, ct, -st], [0.0, st, ct]];
    let y = [[cr, 0.0, sr], [0.0, 1.0, 0.0], [-sr, 0.0, cr]];
    mul(&mul(&z, &x), &y)
}

/// The focal length in pixels of a picture `width` wide.
fn focal_px(focal: f64, sensor: f64, width: f64) -> f64 {
    let f = if focal > 0.0 { focal } else { FOCAL_MM };
    let s = if sensor > 0.0 { sensor } else { SENSOR_MM };
    f / s * width
}

fn apply3(m: &M3, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| (0..3).map(|k| m[i][k] * v[k]).sum())
}

/// The transpose of `m` times `v` (back into the camera's axes).
fn back3(m: &M3, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| (0..3).map(|k| m[k][i] * v[k]).sum())
}

/// Where the point (`px`, `py`) of a `w` × `h` picture, anchored with
/// `track`, is seen by the camera now: how far it moved, and how much
/// bigger it looks (1 unless the layer follows the zoom). None when the
/// camera looks away from it (behind).
pub fn follow(
    track: &Track,
    cam: &CameraSample,
    w: f64,
    h: f64,
    px: f64,
    py: f64,
) -> Option<(f64, f64, f64)> {
    let fa = focal_px(track.focal, track.sensor, w);
    let sensor = if cam.sensor > 0.0 {
        cam.sensor
    } else {
        track.sensor
    };
    let fc = focal_px(cam.focal, sensor, w);
    // The anchor's direction on the stage, the lens distortion of then taken out.
    let (mut x, mut y) = ((px - w / 2.0) / fa, (py - h / 2.0) / fa);
    if let Some(d) = &track.distortion {
        (x, y) = d.undistort(x, y);
    }
    let local = [x, 1.0, -y];
    let ra = rotation(track.pan, track.tilt, track.roll);
    let rc = rotation(cam.pan, cam.tilt, cam.roll);
    let world = apply3(&ra, local);
    // Near: a point of the scene, seen from where the optical centre is now.
    let near = track.distance > 0.0;
    let depth = track.distance / local.iter().map(|v| v * v).sum::<f64>().sqrt();
    let d = if near {
        let then = apply3(&ra, [0.0, cam.pupil, 0.0]);
        let now = apply3(&rc, [0.0, cam.pupil, 0.0]);
        back3(&rc, [0, 1, 2].map(|i| then[i] + world[i] * depth - now[i]))
    } else {
        back3(&rc, world)
    };
    if d[1] <= 1e-6 {
        return None;
    }
    let (mut x, mut y) = (d[0] / d[1], -d[2] / d[1]);
    if let Some(dist) = &cam.distortion {
        (x, y) = dist.distort(x, y);
    }
    let u = fc * x + w / 2.0;
    let v = fc * y + h / 2.0;
    let scale = match (track.zoom, near) {
        (false, _) => 1.0,
        (true, false) => fc / fa,
        // Nearer or farther too.
        (true, true) => fc / fa * depth / d[1],
    };
    Some((u - px, v - py, scale))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam(pan: f64, tilt: f64, focal: f64) -> CameraSample {
        CameraSample {
            pan,
            tilt,
            focal,
            sensor: SENSOR_MM,
            ..Default::default()
        }
    }

    fn track(zoom: bool) -> Track {
        Track {
            pan: 0.0,
            tilt: 0.0,
            roll: 0.0,
            focal: 35.0,
            sensor: SENSOR_MM,
            zoom,
            distance: 0.0,
            distortion: None,
            behind: false,
        }
    }

    #[test]
    fn the_same_camera_moves_nothing() {
        let (dx, dy, s) = follow(
            &track(true),
            &cam(0.0, 0.0, 35.0),
            1920.0,
            1080.0,
            400.0,
            300.0,
        )
        .unwrap();
        assert!(dx.abs() < 1e-9 && dy.abs() < 1e-9 && (s - 1.0).abs() < 1e-9);
    }

    #[test]
    fn panning_left_moves_the_scene_right() {
        // OpenTrackIO: a positive pan turns the camera to its left.
        let (dx, dy, _) = follow(
            &track(false),
            &cam(5.0, 0.0, 35.0),
            1920.0,
            1080.0,
            960.0,
            540.0,
        )
        .unwrap();
        let f = 35.0 / SENSOR_MM * 1920.0;
        assert!((dx - f * 5f64.to_radians().tan()).abs() < 1e-6, "{dx}");
        assert!(dy.abs() < 1e-9);
    }

    #[test]
    fn tilting_up_moves_the_scene_down() {
        let (_, dy, _) = follow(
            &track(false),
            &cam(0.0, 3.0, 35.0),
            1920.0,
            1080.0,
            960.0,
            540.0,
        )
        .unwrap();
        assert!(dy > 0.0);
    }

    #[test]
    fn zooming_in_spreads_and_grows() {
        let (dx, dy, s) = follow(
            &track(true),
            &cam(0.0, 0.0, 70.0),
            1920.0,
            1080.0,
            1460.0,
            540.0,
        )
        .unwrap();
        assert!((dx - 500.0).abs() < 1e-6 && dy.abs() < 1e-9);
        assert!((s - 2.0).abs() < 1e-9);
        let (_, _, s) = follow(
            &track(false),
            &cam(0.0, 0.0, 70.0),
            1920.0,
            1080.0,
            1460.0,
            540.0,
        )
        .unwrap();
        assert_eq!(s, 1.0);
    }

    /// Where the camera at `pan` sees the point (x, z) on the floor plane of
    /// its axis (metres; z forward at rest), its optical centre `pupil` ahead.
    fn seen(pan: f64, pupil: f64, x: f64, z: f64, w: f64) -> f64 {
        let (s, c) = pan.to_radians().sin_cos();
        // OpenTrackIO: a positive pan turns to the left.
        let (ox, oz) = (-pupil * s, pupil * c);
        let (dx, dz) = (x - ox, z - oz);
        let right = dx * c + dz * s;
        let ahead = -dx * s + dz * c;
        w / 2.0 + 35.0 / SENSOR_MM * w * right / ahead
    }

    #[test]
    fn a_near_point_stays_on_its_object() {
        let (w, h) = (1920.0, 1080.0);
        let (x, z) = (0.6, 4.0);
        let pupil = 0.12;
        let px = seen(0.0, pupil, x, z, w);
        let cam = |pan: f64| CameraSample {
            pan,
            focal: 35.0,
            sensor: SENSOR_MM,
            pupil,
            ..Default::default()
        };
        let distance = ((x - 0.0f64).powi(2) + (z - pupil).powi(2)).sqrt();
        let near = Track {
            distance,
            ..track(false)
        };
        for pan in [-12.0, 5.0, 15.0] {
            let want = seen(pan, pupil, x, z, w) - px;
            let (dx, _, _) = follow(&near, &cam(pan), w, h, px, h / 2.0).unwrap();
            assert!((dx - want).abs() < 1e-6, "{pan}°: {dx} for {want}");
            // Far away, it slides off it.
            let (far, _, _) = follow(&track(false), &cam(pan), w, h, px, h / 2.0).unwrap();
            assert!((far - want).abs() > 2.0, "{pan}°: {far} is {want}");
        }
    }

    #[test]
    fn the_distortion_is_taken_out_and_put_back() {
        let d = Distortion {
            k1: -0.08,
            k2: 0.01,
            p1: 0.001,
            ..Default::default()
        };
        let (x, y) = d.undistort(0.4, -0.25);
        let (a, b) = d.distort(x, y);
        assert!((a - 0.4).abs() < 1e-9 && (b + 0.25).abs() < 1e-9);
        let inv = Distortion {
            to_undistorted: true,
            ..d
        };
        let (x, y) = inv.distort(0.4, -0.25);
        let (a, b) = inv.undistort(x, y);
        assert!((a - 0.4).abs() < 1e-9 && (b + 0.25).abs() < 1e-9);
        // The same camera: nothing moves, distortion or not.
        let t = Track {
            distortion: Some(d),
            ..track(true)
        };
        let c = CameraSample {
            distortion: Some(d),
            ..cam(0.0, 0.0, 35.0)
        };
        let (dx, dy, s) = follow(&t, &c, 1920.0, 1080.0, 1700.0, 100.0).unwrap();
        assert!(dx.abs() < 1e-6 && dy.abs() < 1e-6 && (s - 1.0).abs() < 1e-9);
    }

    #[test]
    fn the_html5_renderer_finds_the_same() {
        // web/src/engine/tracking.ts gives these (followed in a browser).
        let d = Distortion {
            k1: -0.08,
            k2: 0.01,
            p1: 0.001,
            ..Default::default()
        };
        let t = Track {
            distance: 3.9,
            distortion: Some(d),
            ..track(true)
        };
        let html5 = [
            (
                -12.0,
                -365.3989799627243,
                4.940493190421023,
                1.3719997429512445,
            ),
            (
                5.0,
                490.4947145792082,
                -14.1206180221223,
                1.4655008936775533,
            ),
            (
                15.0,
                1057.52520887039,
                -40.013852846882116,
                1.5977865293770563,
            ),
        ];
        for (pan, x, y, s) in html5 {
            let c = CameraSample {
                pan,
                tilt: 2.0,
                focal: 50.0,
                sensor: SENSOR_MM,
                pupil: 0.12,
                distortion: Some(d),
                ..Default::default()
            };
            let (dx, dy, k) = follow(&t, &c, 1920.0, 1080.0, 1500.0, 300.0).unwrap();
            assert!(
                (dx - x).abs() < 1e-6 && (dy - y).abs() < 1e-6 && (k - s).abs() < 1e-9,
                "{pan}°"
            );
        }
    }

    #[test]
    fn mixing_goes_the_short_way_round() {
        let a = CameraSample {
            pan: 170.0,
            focal: 20.0,
            ..Default::default()
        };
        let b = CameraSample {
            pan: -170.0,
            focal: 40.0,
            ..Default::default()
        };
        let m = mix(&a, &b, 0.5);
        assert!((m.pan.rem_euclid(360.0) - 180.0).abs() < 1e-9, "{}", m.pan);
        assert!((m.focal - 30.0).abs() < 1e-9);
        // On past the second at the same pace.
        assert!((mix(&a, &b, 2.0).focal - 60.0).abs() < 1e-9);
    }

    #[test]
    fn behind_the_camera_is_nowhere() {
        assert!(follow(
            &track(false),
            &cam(180.0, 0.0, 35.0),
            1920.0,
            1080.0,
            960.0,
            540.0
        )
        .is_none());
    }
}
