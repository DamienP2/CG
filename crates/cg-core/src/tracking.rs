//! Camera tracking: graphics anchored to the scene follow the camera that
//! films it (mirror of web/src/engine/tracking.ts).
//!
//! A sample is the camera's orientation and lens as OpenTrackIO gives them:
//! Z up, right-handed, Y forward at rest, X to the camera's right; pan,
//! tilt and roll in degrees, intrinsic about Z, X then Y. A layer anchored
//! with [`Track`] (`Layer::anchor`) keeps the direction its anchor point was seen in when it
//! was anchored: as the camera turns and zooms, the point goes where that
//! direction is now seen.

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
    // The anchor's direction on the stage.
    let local = [px - w / 2.0, fa, -(py - h / 2.0)];
    let ra = rotation(track.pan, track.tilt, track.roll);
    let world: Vec<f64> = (0..3)
        .map(|i| (0..3).map(|k| ra[i][k] * local[k]).sum())
        .collect();
    // The same direction seen by the camera now (the transpose turns back).
    let rc = rotation(cam.pan, cam.tilt, cam.roll);
    let d: Vec<f64> = (0..3)
        .map(|i| (0..3).map(|k| rc[k][i] * world[k]).sum())
        .collect();
    if d[1] <= 1e-6 {
        return None;
    }
    let u = fc * d[0] / d[1] + w / 2.0;
    let v = -fc * d[2] / d[1] + h / 2.0;
    let scale = if track.zoom { fc / fa } else { 1.0 };
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
