import { create } from 'zustand';
import type { ChannelInfo, ChannelState, Command, Project, ProjectSummary, RundownItem, Template, User, Zone } from './engine/types';

type ServerEvent =
  | { type: 'hello'; user: User | null; serverName: string; serverTime: number; timezone: string; channels: ChannelInfo[]; projects: ProjectSummary[] }
  | { type: 'project'; project: Project }
  | { type: 'projectDeleted'; id: string }
  | { type: 'channels'; channels: ChannelInfo[] }
  | { type: 'channel'; channelId: string; state: ChannelState; serverTime: number }
  | { type: 'error'; message: string };

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
  saveTemplate: (t: Template) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  saveRundown: (r: RundownItem[]) => Promise<void>;
  saveZones: (z: Zone[]) => Promise<boolean>;
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

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
    full: {},
    live: {},
    projectId: null,
    project: null,
    channelId: null,
    toasts: [],

    async init() {
      try {
        set({ auth: await api<AuthState>('GET', '/api/auth/state') });
      } catch (e) {
        get().toast(`Cannot reach the server: ${errText(e)}`, 'error');
        setTimeout(() => get().init(), 2000);
      }
    },

    async login(username, password) {
      const r = await api<{ user: User }>('POST', '/api/auth/login', { username, password });
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
              if (!outputChannel) set({ projects: msg.projects });
              // Refresh projects edited while we were away.
              const { projectId } = get();
              if (projectId && !outputChannel) get().openProject(projectId);
              break;
            }
            case 'project': {
              const full = { ...get().full, [msg.project.id]: msg.project };
              const { id, name, description, width, height, frameRate, templates, rundown } = msg.project;
              const summary: ProjectSummary = { id, name, description: description ?? '', width, height, frameRate, templates: templates.length, rundown: rundown.length };
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
            case 'channels':
              set({ channels: msg.channels });
              break;
            case 'channel':
              set({ live: { ...get().live, [msg.channelId]: { state: msg.state, at: now } }, serverOffset: msg.serverTime - now });
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
      if (!pid) return;
      try {
        await api('PUT', `/api/projects/${encodeURIComponent(pid)}/templates/${encodeURIComponent(t.id)}`, t);
      } catch (e) {
        get().toast(`Save failed: ${errText(e)}`, 'error');
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
      const full = { ...get().full, [p.id]: { ...p, rundown: r } };
      set({ full, ...select(p.id, full) });
      try {
        await api('PUT', `/api/projects/${encodeURIComponent(p.id)}/rundown`, r);
      } catch (e) {
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

    toast(message, kind = 'info') {
      const id = ++toastId;
      set({ toasts: [...get().toasts, { id, message, kind }] });
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 4000);
    },
  };
});

export async function uploadAsset(file: File): Promise<string> {
  const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const res = await fetch(`/api/assets/${encodeURIComponent(name)}`, { method: 'PUT', body: file, credentials: 'same-origin' });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { src: string }).src;
}

/** Rights, mirroring crates/cg-server/src/auth.rs. */
export const can = {
  design: (u: User | null | undefined) => u?.role === 'admin' || u?.role === 'designer',
  operate: (u: User | null | undefined) => u?.role === 'admin' || u?.role === 'designer' || u?.role === 'operator',
  admin: (u: User | null | undefined) => u?.role === 'admin',
};

export const thumbnailUrl = (projectId: string, t: Template, format = 'main') =>
  `/api/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(t.id)}/thumbnail.png?format=${encodeURIComponent(format)}&v=${JSON.stringify(t).length}`;
