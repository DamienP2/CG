import type { FrameRate } from '../engine/types';
import type { MosConfig } from '../mos/MosPage';

/** Mirrors crates/cg-server/src/config.rs and crates/cg-output. */

export type St2110Encoding = 'fillKey' | 'rgba' | 'ycbcra';

export interface St2110Output {
  id: string;
  name: string;
  encoding?: St2110Encoding;
  fill: string;
  key?: string | null;
  interface?: string | null;
  ttl: number;
  payloadType: number;
}

export interface SdiOutput {
  id: string;
  name: string;
  device: number;
  externalKey: boolean;
  fillOnly?: boolean;
  genlock?: boolean;
}

export interface NdiOutput {
  id: string;
  name: string;
  groups: string;
  alpha: boolean;
}

export interface Html5Output {
  id: string;
  name: string;
  background: string;
}

export type StreamProtocol = 'srt' | 'udp' | 'rtmp' | 'hls';

/** An SRT, UDP, RTMP or HLS stream, encoded by ffmpeg (crates/cg-output/src/stream.rs). */
export interface StreamOutput {
  id: string;
  name: string;
  protocol: StreamProtocol;
  /** `srt://host:port`, `udp://239.1.1.1:5000`, `rtmp://server/app/key` (none for HLS). */
  url: string;
  /** SRT: wait for the receivers to call (listener). */
  listen: boolean;
  /** Video bit rate, kbit/s (8000 by default). */
  bitrate: number;
  codec: 'h264' | 'hevc';
  /** Streams carry no alpha: the graphics are laid over this colour. */
  background: string;
  /** A silent stereo track (RTMP platforms usually need one). */
  audio: boolean;
}

export interface OutputsConfig {
  st2110: St2110Output[];
  sdi: SdiOutput[];
  ndi?: NdiOutput[];
  html5?: Html5Output[];
  streams?: StreamOutput[];
}

export type InputKind = 'srt' | 'udp' | 'rtmp' | 'hls' | 'rtsp' | 'url' | 'ndi' | 'sdi';

/** A live video input (crates/cg-server/src/inputs.rs). */
export interface InputConfig {
  id: string;
  name: string;
  kind: InputKind;
  url: string;
  /** SRT / RTMP: wait for the sender to connect. */
  listen: boolean;
  /** NDI: the source name ("HOST (name)"). */
  ndiSource: string;
  /** SDI: DeckLink device index. */
  device: number;
  /** Streams are decoded at this size (the picture fitted inside) and rate. */
  width: number;
  height: number;
  fps: number;
  /** Smoothing buffer, in frames (2 by default; 0 = lowest latency). */
  buffer: number;
  /** Streams: decode on the GPU when the machine has a decoder (ffmpeg falls back to the processor). */
  hwDecode: boolean;
}

/** `GET /api/inputs`. */
export interface InputInfo {
  id: string;
  name: string;
  kind: InputKind;
  /** A picture came in the last 2 s. */
  live: boolean;
  message: string;
  width: number;
  height: number;
  frames: number;
}

export interface Rendition {
  id: string;
  name: string;
  width: number;
  height: number;
  outputs: OutputsConfig;
}

export interface ChannelConfig {
  id: string;
  name: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  projectId?: string | null;
  outputs: OutputsConfig;
  renditions?: Rendition[];
  location?: string;
}

export interface Location {
  id: string;
  name: string;
}

export interface ServerConfig {
  name: string;
  bind?: string | null;
  publicOutputs: boolean;
  timezone: string;
  /** Path of the NDI runtime library ("" = search for it). */
  ndiLibrary?: string;
  locations?: Location[];
  channels: ChannelConfig[];
  mos: MosConfig;
  /** Live video inputs. */
  inputs?: InputConfig[];
}

export interface SystemInfo {
  version: string;
  os: string;
  arch: string;
  hostname: string;
  cpus: number;
  dataDir: string;
  bind: string;
  uptimeSecs: number;
  timezone: string;
  config: ServerConfig;
  interfaces: { name: string; ip: string }[];
}

export interface OutputState {
  ok: boolean;
  message: string;
  /** The full error, when it says more. */
  detail?: string;
}

export const VIDEO_FORMATS: { label: string; width: number; height: number; rate: FrameRate }[] = [
  { label: '1080p 50', width: 1920, height: 1080, rate: { num: 50, den: 1 } },
  { label: '1080p 25', width: 1920, height: 1080, rate: { num: 25, den: 1 } },
  { label: '1080p 59.94', width: 1920, height: 1080, rate: { num: 60000, den: 1001 } },
  { label: '1080p 29.97', width: 1920, height: 1080, rate: { num: 30000, den: 1001 } },
  { label: '1080p 60', width: 1920, height: 1080, rate: { num: 60, den: 1 } },
  { label: '720p 50', width: 1280, height: 720, rate: { num: 50, den: 1 } },
  { label: '720p 59.94', width: 1280, height: 720, rate: { num: 60000, den: 1001 } },
  { label: '2160p 50 (UHD)', width: 3840, height: 2160, rate: { num: 50, den: 1 } },
  { label: '2160p 59.94 (UHD)', width: 3840, height: 2160, rate: { num: 60000, den: 1001 } },
];

export const splitAddr = (a?: string | null): [string, string] => {
  if (!a) return ['', ''];
  const i = a.lastIndexOf(':');
  return i < 0 ? [a, ''] : [a.slice(0, i), a.slice(i + 1)];
};
export const joinAddr = (ip: string, port: string) => `${ip.trim()}:${port.trim()}`;
