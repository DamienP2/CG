import type { FrameRate } from '../engine/types';
import type { MosConfig } from '../mos/MosPage';

/** Mirrors crates/cg-server/src/config.rs and crates/cg-output. */

export type St2110Encoding = 'fillKey' | 'rgba' | 'ycbcra';

export interface St2110Output {
  id: string;
  /** Off: kept in the settings, not started (true when missing). */
  enabled?: boolean;
  name: string;
  /** The ST 2110 output flow of Hardware it sends: the server copies the fields below from it. */
  hardware?: string;
  encoding?: St2110Encoding;
  fill: string;
  key?: string | null;
  interface?: string | null;
  ttl: number;
  payloadType: number;
}

export interface SdiOutput {
  id: string;
  enabled?: boolean;
  name: string;
  /** The SDI output of Hardware it sends to: the server copies the fields below from it. */
  hardware?: string;
  device: number;
  externalKey: boolean;
  fillOnly?: boolean;
  genlock?: boolean;
}

export interface NdiOutput {
  id: string;
  enabled?: boolean;
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
  enabled?: boolean;
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
  /** Hardware encoder (VideoToolbox, NVENC, Quick Sync, AMF); falls back to the processor. */
  hwEncode?: boolean;
}

export interface OutputsConfig {
  st2110: St2110Output[];
  sdi: SdiOutput[];
  ndi?: NdiOutput[];
  html5?: Html5Output[];
  streams?: StreamOutput[];
}

export type InputKind = 'srt' | 'udp' | 'rtmp' | 'hls' | 'rtsp' | 'url' | 'ndi' | 'sdi' | 'st2110';

/** A live video input (crates/cg-server/src/inputs.rs). */
export interface InputConfig {
  id: string;
  /** Off: kept in the settings, not started (true when missing). */
  enabled?: boolean;
  name: string;
  kind: InputKind;
  url: string;
  /** SRT / RTMP: wait for the sender to connect. */
  listen: boolean;
  /** NDI: the source name ("HOST (name)"). */
  ndiSource: string;
  /** SDI: DeckLink device index (filled by the server from `hardware`). */
  device: number;
  /** SDI / ST 2110: the input of Hardware it receives. */
  hardware?: string;
  /** SRT listener: the port the server listens on (srt://0.0.0.0:<port>). */
  port?: number;
  /** SRT latency, ms (120 by default). */
  latency?: number;
  /** Pre-detection decoded size and rate (no longer shown: the server detects them). */
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
  /** Still picture (`/assets/…`) its outputs show while no project is loaded ("" = none). */
  slate?: string;
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
  /** Still picture (`/assets/…`) the main format shows while no project is loaded ("" = none). */
  slate?: string;
  /** Frames rendered ahead, each on its own thread (1–4, 2 by default). */
  renderAhead?: number;
  /** Destinations wired to no format: kept, not started. */
  unwired?: OutputsConfig;
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
  /** DeckLink cards and ST 2110 flows (Hardware page). */
  hardware?: HardwareConfig;
}

// ---- Hardware (crates/cg-server/src/hardware.rs) ----

export type SdiModel = 'miniMonitor' | 'miniRecorder' | 'sdi4k' | 'duo2' | 'quad2' | '8kPro' | 'other';

export interface SdiCard {
  id: string;
  name: string;
  model: SdiModel;
  /** Index of the card's first device in Desktop Video (0 = first). */
  device: number;
  /** What each connector is wired to; its role comes from the outputs and inputs using it. */
  connectors: { name: string }[];
}

export type SdiMode = 'externalKey' | 'internalKey' | 'fillOnly';

export interface SdiOutputDef {
  id: string;
  name: string;
  card: string;
  /** Connector of the fill (0 = first). */
  fill: number;
  /** Connector of the key (external keyer). */
  key?: number | null;
  mode: SdiMode;
  genlock: boolean;
}

export interface SdiInputDef {
  id: string;
  name: string;
  card: string;
  connector: number;
}

export interface St2110Flow {
  id: string;
  name: string;
  direction: 'output' | 'input';
  encoding: St2110Encoding;
  fill: string;
  key?: string | null;
  interface?: string | null;
  ttl: number;
  payloadType: number;
}

export interface HardwareConfig {
  sdi: { cards: SdiCard[]; outputs: SdiOutputDef[]; inputs: SdiInputDef[] };
  st2110: { flows: St2110Flow[] };
}

export const emptyHardware = (): HardwareConfig => ({ sdi: { cards: [], outputs: [], inputs: [] }, st2110: { flows: [] } });

/** `GET /api/hardware`. */
export interface HardwareInfo {
  desktopVideo: boolean;
  desktopVideoPath?: string | null;
  decklinkSupport: boolean;
  st2110Receive: boolean;
  interfaces: { name: string; ip: string; loopback: boolean }[];
  os: string;
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
