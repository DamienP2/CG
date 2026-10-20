import { useEffect, useRef } from 'react';
import { setLang, t } from './i18n';
import { create } from 'zustand';
import { useData } from './data/dataStore';
import { designTemplates } from './engine/drafts';
import type { ChannelInfo, ChannelState, Command, DataStatus, Project, ProjectSummary, RundownItem, Template, User, Zone } from './engine/types';

type ServerEvent =
  | { type: 'hello'; user: User | null; serverName: string; serverTime: number; timezone: string; channels: ChannelInfo[]; projects: ProjectSummary[] }
  | { type: 'project'; project: Project }
  | { type: 'projectDeleted'; id: string }
  | { type: 'channels'; channels: ChannelInfo[] }
  | { type: 'channel'; channelId: string; state: ChannelState; serverTime: number }
  | { type: 'data'; source: string; status: DataStatus }
  | { type: 'lock'; projectId: string; templateId: string; lock: EditLock | null; takenFrom: string | null }
  | { type: 'folders'; folders: Folders }
  | { type: 'changed'; what: string }
  | { type: 'error'; message: string };

/** Folders of the project list (one level) and the folder of each project. */
export interface Folders {
  folders: string[];
  assign: Record<string, string>;
}

interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

export interface AuthState {
  needsSetup: boolean;
  user: User | null;
  serverName: string;
  publicOutputs: boolean;
}

/** Channel state plus when it arrived, to extrapolate widget time. */
export interface Live {
  state: ChannelState;
  /** Client clock (ms) when received. */
  at: number;
}

interface AppStore {
  auth: AuthState | null;
  connected: boolean;
  /** Server clock − client clock, ms. */
  serverOffset: number;
  timezone: string;
  channels: ChannelInfo[];
  projects: ProjectSummary[];
  folders: Folders;
  /** Full projects received so far. */
  full: Record<string, Project>;
  live: Record<string, Live>;
  /** Project being designed, or loaded on the operated channel. */
  projectId: string | null;
  project: Project | null;
  channelId: string | null;
  toasts: Toast[];

  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  connect: (outputChannel?: string) => void;
  openProject: (id: string | null) => Promise<void>;
  selectChannel: (id: string | null) => void;
  command: (cmd: Command, channelId?: string) => void;
  loadOnChannel: (channelId: string, projectId: string | null) => Promise<void>;
  /** False when not saved (already toasted). */
  saveTemplate: (t: Template) => Promise<boolean>;
  deleteTemplate: (id: string) => Promise<void>;
  saveRundown: (r: RundownItem[]) => Promise<void>;
  saveZones: (z: Zone[]) => Promise<boolean>;
  saveFolders: (f: Folders) => Promise<void>;
  toast: (message: string, kind?: Toast['kind']) => void;
}

let socket: WebSocket | null = null;
let toastId = 0;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** API key used instead of the session cookie (pages embedded in other
 *  applications: newsroom MOS plugin). */
let apiKey: string | null = null;
export const setApiKey = (k: string | null) => void (apiKey = k);

/** A designer's edit lock on a template. */
export interface EditLock {
  userId: string;
  userName: string;
  client: string;
  since: number;
}

/** Lock changes pushed by the server (`detail`: the event). */
export const lockEvents = new EventTarget();

/** Lists changed by another client (`media`, `media:<project>`, `sources`, `config`). */
export const changeEvents = new EventTarget();

/** Calls `fn` whenever another client changes `what`. */
export function useChanged(what: string, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    changeEvents.addEventListener(what, h);
    return () => changeEvents.removeEventListener(what, h);
  }, [what]);
}

/** This browser tab, for designer edit locks. */
export const clientId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Pulse-Client': clientId };
  // A file goes as it is; anything else as JSON.
  const raw = typeof Blob !== 'undefined' && body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = raw ? (body as Blob).type || 'application/octet-stream' : 'application/json';
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : raw ? (body as Blob) : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // Session expired: back to the login page.
    const a = useApp.getState().auth;
    if (a?.user) useApp.setState({ auth: { ...a, user: null } });
  }
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useApp = create<AppStore>((set, get) => {
  /** Keeps `project` in sync with the cache and the selection. */
  const select = (projectId: string | null, full = get().full) => ({ projectId, project: (projectId && full[projectId]) || null });

  return {
    auth: null,
    connected: false,
    serverOffset: 0,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    channels: [],
    projects: [],
    folders: { folders: [], assign: {} },
    full: {},
    live: {},
    projectId: null,
    project: null,
    channelId: null,
    toasts: [],

    async init() {
      try {
        const auth = await api<AuthState>('GET', '/api/auth/state');
        // The user's language before anything is drawn.
        setLang(auth.user?.lang);
        set({ auth });
      } catch (e) {
        get().toast(t('Cannot reach the server: {error}', { error: errText(e) }), 'error');
        setTimeout(() => get().init(), 2000);
      }
    },

    async login(username, password) {
      const r = await api<{ user: User }>('POST', '/api/auth/login', { username, password });
      setLang(r.user.lang);
      set({ auth: { ...get().auth!, user: r.user } });
      socket?.close();
    },

    async setup(username, password, displayName) {
      const r = await api<{ user: User }>('POST', '/api/auth/setup', { username, password, displayName });
      set({ auth: { ...get().auth!, needsSetup: false, user: r.user } });
    },

    async logout() {
      await api('POST', '/api/auth/logout').catch(() => {});
      socket?.close();
      set({ auth: { ...get().auth!, user: null }, full: {}, projects: [], channels: [], live: {}, ...select(null, {}) });
    },

    connect(outputChannel) {
      if (socket) return;
      const q = outputChannel ? `?channel=${encodeURIComponent(outputChannel)}` : '';
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
      let delay = 500;
      const open = () => {
        const ws = new WebSocket(url);
        socket = ws;
        ws.onopen = () => {
          delay = 500;
          set({ connected: true });
        };
        ws.onclose = () => {
          set({ connected: false });
          if (socket === ws) socket = null;
          // Logged out: do not hammer the server.
          if (!outputChannel && !get().auth?.user) return;
          setTimeout(() => !socket && open(), delay);
          delay = Math.min(delay * 2, 5000);
        };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data) as ServerEvent;
          const now = Date.now();
          switch (msg.type) {
            case 'hello': {
              set({ channels: msg.channels, timezone: msg.timezone, serverOffset: msg.serverTime - now });
              if (!outputChannel) {
                set({ projects: msg.projects });
                api<Folders>('GET', '/api/folders').then((folders) => set({ folders }), () => {});
              }
              // Refresh projects edited while we were away.
              const { projectId } = get();
              if (projectId && !outputChannel) get().openProject(projectId);
              break;
            }
            case 'project': {
              const full = { ...get().full, [msg.project.id]: msg.project };
              const { id, name, description, width, height, frameRate, rundown } = msg.project;
              const design = designTemplates(msg.project);
              const summary: ProjectSummary = { id, name, description: description ?? '', width, height, frameRate, templates: design.length, rundown: rundown.length, cover: design[0]?.id };
              const projects = get().projects.some((p) => p.id === id) ? get().projects.map((p) => (p.id === id ? summary : p)) : [...get().projects, summary];
              set({ full, projects: outputChannel ? get().projects : projects, ...select(get().projectId, full) });
              break;
            }
            case 'projectDeleted': {
              const full = { ...get().full };
              delete full[msg.id];
              set({ full, projects: get().projects.filter((p) => p.id !== msg.id), ...select(get().projectId === msg.id ? null : get().projectId, full) });
              break;
            }
            case 'folders':
              set({ folders: msg.folders });
              break;
            case 'changed':
              changeEvents.dispatchEvent(new CustomEvent(msg.what));
              if (msg.what === 'sources') void useData.getState().load();
              break;
            case 'channels':
              set({ channels: msg.channels });
              break;
            case 'channel':
              set({ live: { ...get().live, [msg.channelId]: { state: msg.state, at: now } }, serverOffset: msg.serverTime - now });
              break;
            case 'lock':
              lockEvents.dispatchEvent(new CustomEvent('lock', { detail: msg }));
              break;
            case 'data':
              useData.getState().onStatus(msg.source, msg.status);
              break;
            case 'error':
              get().toast(msg.message, 'error');
              break;
          }
        };
      };
      open();
    },

    async openProject(id) {
      set(select(id));
      if (!id) return;
      try {
        const p = await api<Project>('GET', `/api/projects/${encodeURIComponent(id)}`);
        const full = { ...get().full, [id]: p };
        set({ full, ...select(get().projectId, full) });
      } catch (e) {
        get().toast(`Cannot open the project: ${errText(e)}`, 'error');
      }
    },

    selectChannel(id) {
      set({ channelId: id });
    },

    command(cmd, channelId = get().channelId ?? undefined) {
      if (!channelId) return;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'command', channelId, command: cmd }));
      else api('POST', `/api/channels/${encodeURIComponent(channelId)}/command`, cmd).catch((e) => get().toast(errText(e), 'error'));
    },

    async loadOnChannel(channelId, projectId) {
      try {
        await api('PUT', `/api/channels/${encodeURIComponent(channelId)}/project`, { projectId });
      } catch (e) {
        get().toast(errText(e), 'error');
      }
    },

    async saveTemplate(t) {
      const pid = get().projectId;
      if (!pid) return false;
      try {
        await api('PUT', `/api/projects/${encodeURIComponent(pid)}/templates/${encodeURIComponent(t.id)}`, t);
        return true;
      } catch (e) {
        get().toast(`Save failed: ${errText(e)}`, 'error');
        return false;
      }
    },

    async deleteTemplate(id) {
      const pid = get().projectId;
      if (!pid) return;
      await api('DELETE', `/api/projects/${encodeURIComponent(pid)}/templates/${encodeURIComponent(id)}`);
    },

    async saveRundown(r) {
      const p = get().project;
      if (!p) return;
      const before = p.rundown;
      const full = { ...get().full, [p.id]: { ...p, rundown: r } };
      set({ full, ...select(p.id, full) });
      try {
        // Only this change: another operator's edits made meanwhile are kept.
        await api('PUT', `/api/projects/${encodeURIComponent(p.id)}/rundown`, { base: before, rundown: r });
      } catch (e) {
        // Not saved: back to what the server has, so Take does not use it.
        const cur = get().full[p.id];
        if (cur && cur.rundown === r) {
          const back = { ...get().full, [p.id]: { ...cur, rundown: before } };
          set({ full: back, ...select(p.id, back) });
        }
        get().toast(`Save failed: ${errText(e)}`, 'error');
      }
    },

    async saveZones(zones) {
      const p = get().project;
      if (!p) return false;
      try {
        await api('PUT', `/api/projects/${encodeURIComponent(p.id)}/zones`, zones);
        return true;
      } catch (e) {
        get().toast(errText(e), 'error');
        return false;
      }
    },

    async saveFolders(f) {
      set({ folders: f });
      try {
        set({ folders: await api<Folders>('PUT', '/api/folders', f) });
      } catch (e) {
        get().toast(errText(e), 'error');
      }
    },

    toast(message, kind = 'info') {
      const id = ++toastId;
      set({ toasts: [...get().toasts, { id, message, kind }] });
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 4000);
    },
  };
});

/** A file of a media library. */
export interface MediaFile {
  name: string;
  src: string;
  size: number;
  modified: number;
  kind: 'image' | 'video' | 'audio' | 'font' | 'other';
}

/** Media library URL: a project's, or the one shared by every project. */
export const mediaUrl = (projectId?: string | null) => (projectId ? `/api/projects/${encodeURIComponent(projectId)}/media` : '/api/media');

export const mediaName = (fileName: string) => fileName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'file';

/** Uploads a file to a media library (the project's when given) and returns its URL. */
export async function uploadAsset(file: File, projectId?: string | null, onProgress?: (fraction: number) => void): Promise<string> {
  const url = `${mediaUrl(projectId)}/${encodeURIComponent(mediaName(file.name))}`;
  // XMLHttpRequest: fetch has no upload progress.
  const xhr = new XMLHttpRequest();
  const done = new Promise<string>((resolve, reject) => {
    xhr.onload = () => (xhr.status < 300 ? resolve((JSON.parse(xhr.responseText) as MediaFile).src) : reject(new Error(xhr.responseText || xhr.statusText)));
    xhr.onerror = () => reject(new Error('Upload failed'));
  });
  xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
  xhr.open('PUT', url);
  xhr.withCredentials = true;
  if (apiKey) xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`);
  xhr.send(file);
  return done;
}

/** Imports an After Effects composition (Bodymovin / LottieFiles export) as a new template. */
export async function importAfterEffects(projectId: string, file: File, layersOnly = false): Promise<{ template: Template; warnings: string[] }> {
  const name = file.name.replace(/\.(json|zip|lottie|mogrt)$/i, '');
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/import/after-effects?name=${encodeURIComponent(name)}${layersOnly ? '&layersOnly=true' : ''}`, {
    method: 'POST',
    body: file,
    credentials: 'same-origin',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

/** Rights, mirroring crates/cg-server/src/auth.rs. */
export const can = {
  design: (u: User | null | undefined) => u?.role === 'admin' || u?.role === 'designer',
  operate: (u: User | null | undefined) => u?.role === 'admin' || u?.role === 'designer' || u?.role === 'operator',
  admin: (u: User | null | undefined) => u?.role === 'admin',
};

export const thumbnailUrl = (projectId: string, t: Template, format = 'main', draft = false) =>
  `/api/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(t.id)}/thumbnail.png?format=${encodeURIComponent(format)}${draft ? '&draft=true' : ''}&v=${JSON.stringify(t).length}`;
