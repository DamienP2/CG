import { createContext, useContext } from 'react';
import { useApp } from '../store';
import { useFrameNow } from './frameClock';
import { create } from 'zustand';
import type { Resolved } from './evaluate';
import type { CameraSample, Layer, Track } from './types';

/**
 * Camera tracking (mirror of cg_core::tracking): a layer anchored to the
 * scene keeps the direction its anchor point was seen in, and goes where the
 * camera sees that direction now. OpenTrackIO: Z up, Y forward, X to the
 * camera's right; pan, tilt, roll in degrees, intrinsic about Z, X then Y.
 */

/** The FR7's full-frame sensor width (16:9 area), when the camera does not tell it. */
export const SENSOR_MM = 35.6;
/** The focal length assumed when the camera does not tell it. */
export const FOCAL_MM = 35;

type M3 = number[][];
const mul = (a: M3, b: M3): M3 => a.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));

function rotation(pan: number, tilt: number, roll: number): M3 {
  const [p, t, r] = [pan, tilt, roll].map((d) => (d * Math.PI) / 180);
  const z = [
    [Math.cos(p), -Math.sin(p), 0],
    [Math.sin(p), Math.cos(p), 0],
    [0, 0, 1],
  ];
  const x = [
    [1, 0, 0],
    [0, Math.cos(t), -Math.sin(t)],
    [0, Math.sin(t), Math.cos(t)],
  ];
  const y = [
    [Math.cos(r), 0, Math.sin(r)],
    [0, 1, 0],
    [-Math.sin(r), 0, Math.cos(r)],
  ];
  return mul(mul(z, x), y);
}

const focalPx = (focal: number | undefined, sensor: number | undefined, width: number) => ((focal || FOCAL_MM) / (sensor || SENSOR_MM)) * width;

/** How far the point (px, py) of a w × h picture moved, and how much bigger it looks; null when the camera looks away. */
export function follow(track: Track, cam: CameraSample, w: number, h: number, px: number, py: number): [number, number, number] | null {
  const fa = focalPx(track.focal, track.sensor, w);
  const fc = focalPx(cam.focal, cam.sensor || track.sensor, w);
  const local = [px - w / 2, fa, -(py - h / 2)];
  const ra = rotation(track.pan, track.tilt, track.roll ?? 0);
  const world = [0, 1, 2].map((i) => ra[i].reduce((s, v, k) => s + v * local[k], 0));
  const rc = rotation(cam.pan, cam.tilt, cam.roll);
  const d = [0, 1, 2].map((i) => [0, 1, 2].reduce((s, k) => s + rc[k][i] * world[k], 0));
  if (d[1] <= 1e-6) return null;
  const u = (fc * d[0]) / d[1] + w / 2;
  const v = (-fc * d[2]) / d[1] + h / 2;
  return [u - px, v - py, track.zoom ? fc / fa : 1];
}

/** A layer's values moved where the camera sees its anchor point now (mirror of cg_core::anim::apply_track). */
export function applyTrack(r: Resolved, track: Track, cam: CameraSample, w: number, h: number): Resolved {
  const n = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
  const px = n(r.x) + n(r.anchorX) * n(r.width);
  const py = n(r.y) + n(r.anchorY) * n(r.height);
  const m = follow(track, cam, w, h, px, py);
  if (!m) return { ...r, opacity: 0 };
  return { ...r, x: n(r.x) + m[0], y: n(r.y) + m[1], scaleX: n(r.scaleX, 1) * m[2], scaleY: n(r.scaleY, 1) * m[2] };
}

/** The anchor of a layer seen by `cam` now (its focal and sensor kept). */
export const anchorFrom = (cam: CameraSample, zoom = true): Track => ({ pan: cam.pan, tilt: cam.tilt, roll: cam.roll, focal: cam.focal, sensor: cam.sensor, zoom });

/** A camera's sample and when it is to be shown (server clock, ms; its delay added). */
export type TimedSample = CameraSample & { t: number };

/** Samples kept by camera (half a second at 50 a second). */
const KEPT = 25;
/** How far past the last sample a camera goes on at the same pace, in samples. */
const AHEAD = 3;

/** Where the tracked cameras look, by tracking input: the last samples, and the latest (what the pages show). */
export const useCameras = create<{ history: Record<string, TimedSample[]>; samples: Record<string, CameraSample> }>(() => ({ history: {}, samples: {} }));

/** The samples the server sent (each with the ones before it) added to those kept. */
export function receiveCameras(sent: Record<string, TimedSample[]>) {
  const { history } = useCameras.getState();
  const next: Record<string, TimedSample[]> = {};
  const samples: Record<string, CameraSample> = {};
  for (const [id, list] of Object.entries(sent)) {
    const kept = history[id] ?? [];
    const last = kept.length ? kept[kept.length - 1].t : -Infinity;
    // A camera started again: its clock too.
    const fresh = list.length && list[0].t < last - 1000 ? list : [...kept, ...list.filter((x) => x.t > last)];
    next[id] = fresh.slice(-KEPT);
    if (next[id].length) samples[id] = next[id][next[id].length - 1];
  }
  useCameras.setState({ history: next, samples });
}

/** The camera `k` of the way from `a` to `b` (mirror of cg_core::tracking::mix). */
export function mix(a: CameraSample, b: CameraSample, k: number): CameraSample {
  const lin = (x: number, y: number) => x + (y - x) * k;
  const ang = (x: number, y: number) => x + ((((y - x + 540) % 360) + 360) % 360 - 180) * k;
  return { pan: ang(a.pan, b.pan), tilt: ang(a.tilt, b.tilt), roll: ang(a.roll, b.roll), focal: lin(a.focal, b.focal), sensor: b.sensor, focus: lin(a.focus ?? 0, b.focus ?? 0), iris: lin(a.iris ?? 0, b.iris ?? 0), x: lin(a.x ?? 0, b.x ?? 0), y: lin(a.y ?? 0, b.y ?? 0), z: lin(a.z ?? 0, b.z ?? 0) };
}

/** Where the camera looks at `t` (server clock, ms): between the samples around then, on from the last a little while (mirror of the server's). */
export function cameraAt(list: TimedSample[] | undefined, t: number): CameraSample | undefined {
  if (!list?.length) return undefined;
  const i = list.findIndex((x) => x.t > t);
  if (i === 0) return list[0];
  if (list.length < 2) return list[0];
  const [a, b] = i < 0 ? [list[list.length - 2], list[list.length - 1]] : [list[i - 1], list[i]];
  const span = b.t - a.t;
  if (span <= 0) return b;
  return mix(a, b, Math.min((t - a.t) / span, 1 + AHEAD));
}

/** The picture the layers are laid out in, and the camera shown instead of the received one (the Designer's preview). */
export interface TrackStage {
  w: number;
  h: number;
  /** The Designer's simulated camera; none: the received one. */
  sim?: CameraSample;
}
export const TrackContext = createContext<TrackStage | null>(null);
/** The tracking input the template drawn follows. */
export const TemplateCamera = createContext<string | undefined>(undefined);

/** Where the camera of the template drawn looks when this frame is shown (re-renders the caller on each frame); none: not anchored or no camera. */
export function useTrackedCamera(layer: Layer): { cam: CameraSample; w: number; h: number } | null {
  const stage = useContext(TrackContext);
  const id = useContext(TemplateCamera);
  const anchored = !!layer.anchor && !layer.parent && !!id && !!stage;
  const now = useFrameNow(anchored && !stage?.sim);
  const offset = useApp((s) => s.serverOffset);
  if (!anchored) return null;
  const cam = stage!.sim ?? cameraAt(useCameras.getState().history[id!], now + offset);
  return cam ? { cam, w: stage!.w, h: stage!.h } : null;
}
