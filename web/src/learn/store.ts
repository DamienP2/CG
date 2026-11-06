import { create } from 'zustand';
import { api } from '../store';
import { navigate, projectPath } from '../router';
import { setDisplayPref, useDisplayPrefs } from '../displayPrefs';
import type { Lesson } from './types';
import { LESSONS } from './lessons';

/*
 * The lesson going on (kept for the tab: a reload goes on with it), the
 * person's training project, and the lessons they did (kept on the server
 * with their display choices, `learn.done`).
 */

interface Active {
  id: string;
  step: number;
  /** Its last step done: « Lesson done ». */
  ended?: boolean;
}

const KEY = 'strata.learn';
const restore = (): Active | null => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};

export const useLearn = create<{ project: string | null; active: Active | null }>(() => ({ project: null, active: restore() }));
useLearn.subscribe((s) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s.active));
  } catch {
    /* private mode */
  }
});

/** Lessons made while the page runs (an example's tour). */
const made = new Map<string, Lesson>();
export const addLesson = (l: Lesson) => made.set(l.id, l);
export const lessonById = (id: string): Lesson | undefined => made.get(id) ?? LESSONS.find((l) => l.id === id);

/** The training project of this person (none: null). */
export async function loadTraining() {
  const r = await api<{ project: string | null }>('GET', '/api/learn').catch(() => null);
  if (r) useLearn.setState({ project: r.project });
}

/** Starts a lesson: its training project made, its page opened. */
export async function startLesson(id: string) {
  const l = lessonById(id);
  if (!l) return;
  const s = l.setup;
  if (s.kind === 'page') {
    useLearn.setState({ active: { id, step: 0 } });
    navigate(s.path);
    return;
  }
  const r = await api<{ project: string }>('POST', '/api/learn', { example: s.example ?? null });
  useLearn.setState({ project: r.project, active: { id, step: 0 } });
  navigate(projectPath(r.project, s.kind));
}

/** The step done: the next one, or the lesson done. */
export function nextStep() {
  const a = useLearn.getState().active;
  const l = a && lessonById(a.id);
  if (!a || !l || a.ended) return;
  if (a.step + 1 < l.steps.length) useLearn.setState({ active: { ...a, step: a.step + 1 } });
  else {
    useLearn.setState({ active: { ...a, ended: true } });
    if (!made.has(a.id)) markDone(a.id);
  }
}

/** Out of the lesson: its training project goes, back to the lessons. */
export async function quitLesson() {
  const had = useLearn.getState().project;
  useLearn.setState({ active: null, project: null });
  navigate('/learn');
  if (had) await api('DELETE', '/api/learn').catch(() => {});
}

export function markDone(id: string) {
  const done = doneList();
  if (!done.includes(id)) setDisplayPref('learn.done', [...done, id]);
}

const doneList = (): string[] => {
  const v = useDisplayPrefs.getState().values['learn.done'];
  return Array.isArray(v) ? (v as string[]) : [];
};

/** The lessons this person did. */
export function useDone(): Set<string> {
  const v = useDisplayPrefs((s) => s.values['learn.done']);
  return new Set(Array.isArray(v) ? (v as string[]) : []);
}

/** The lesson after `id` in its part (none: the last one). */
export function lessonAfter(id: string): Lesson | undefined {
  const l = lessonById(id);
  if (!l) return undefined;
  const same = LESSONS.filter((x) => x.cat === l.cat);
  return same[same.indexOf(l) + 1];
}
