import { create } from 'zustand';
import type { ChannelState, Command, Project, RundownItem, Template } from './engine/types';

type ServerEvent =
  | { type: 'project'; project: Project }
  | { type: 'channel'; state: ChannelState }
  | { type: 'error'; message: string };

interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

interface AppStore {
  project: Project | null;
  channel: ChannelState;
  connected: boolean;
  toasts: Toast[];
  connect: () => void;
  command: (cmd: Command) => void;
  saveTemplate: (t: Template) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  saveRundown: (r: RundownItem[]) => Promise<void>;
  saveProject: (p: Project) => Promise<void>;
  toast: (message: string, kind?: Toast['kind']) => void;
}

let socket: WebSocket | null = null;
let toastId = 0;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res;
}

export const useApp = create<AppStore>((set, get) => ({
  project: null,
  channel: { layers: {} },
  connected: false,
  toasts: [],

  connect() {
    if (socket) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const open = () => {
      socket = new WebSocket(url);
      socket.onopen = () => set({ connected: true });
      socket.onclose = () => {
        set({ connected: false });
        socket = null;
        setTimeout(open, 1000);
      };
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerEvent;
        if (msg.type === 'project') set({ project: msg.project });
        else if (msg.type === 'channel') set({ channel: msg.state });
        else if (msg.type === 'error') get().toast(msg.message, 'error');
      };
    };
    open();
  },

  command(cmd) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'command', command: cmd }));
    else api('POST', '/api/channel/command', cmd).catch((e) => get().toast(String(e.message ?? e), 'error'));
  },

  async saveTemplate(t) {
    try {
      await api('PUT', `/api/templates/${encodeURIComponent(t.id)}`, t);
    } catch (e) {
      get().toast(`Save failed: ${(e as Error).message}`, 'error');
    }
  },

  async deleteTemplate(id) {
    await api('DELETE', `/api/templates/${encodeURIComponent(id)}`);
  },

  async saveRundown(r) {
    const p = get().project;
    if (p) set({ project: { ...p, rundown: r } });
    try {
      await api('PUT', '/api/rundown', r);
    } catch (e) {
      get().toast(`Save failed: ${(e as Error).message}`, 'error');
    }
  },

  async saveProject(p) {
    set({ project: p });
    try {
      await api('PUT', '/api/project', p);
    } catch (e) {
      get().toast(`Save failed: ${(e as Error).message}`, 'error');
    }
  },

  toast(message, kind = 'info') {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, message, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 4000);
  },
}));

export async function uploadAsset(file: File): Promise<string> {
  const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const res = await fetch(`/api/assets/${encodeURIComponent(name)}`, { method: 'PUT', body: file });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { src: string }).src;
}
