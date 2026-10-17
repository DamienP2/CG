import type { FrameRate } from '../engine/types';
import type { MosConfig } from '../settings/Mos';

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

export interface OutputsConfig {
  st2110: St2110Output[];
  sdi: SdiOutput[];
  ndi?: NdiOutput[];
  html5?: Html5Output[];
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
  locations?: Location[];
  channels: ChannelConfig[];
  mos: MosConfig;
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
