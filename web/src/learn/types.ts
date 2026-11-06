/*
 * Lessons (« Apprendre »): done by hand, on a training project (a blank one,
 * or one made from an example) or on the real pages. Each step points at a
 * place of the page and moves on once the person did what it says.
 */

export type Cat = 'admin' | 'designer' | 'operator';

/** A text in both languages of the interface. */
export interface Text {
  fr: string;
  en: string;
}

/** Where the lesson happens. */
export type Setup =
  /** The Designer of a training project: blank, or made from an example (`ex-…`). */
  | { kind: 'designer'; example?: string }
  /** The Operator of a training project made from an example: a simulation, nothing goes on air. */
  | { kind: 'operator'; example: string }
  /** A page of the application (`/system/users`…): nothing is saved by the lesson. */
  | { kind: 'page'; path: string };

/**
 * When a step is done: an OK button (`'next'`), a test of the application's
 * state (called a few times a second), a click on an element, or a key.
 */
export type Done = 'next' | (() => boolean) | { click: string } | { key: string };

export interface Step {
  /** One or two short sentences. */
  say: Text;
  /** The place it points at: a CSS selector (the first one shown), or a function. */
  at?: string | (() => Element | null | undefined);
  done?: Done;
  /** Done when the step starts (select a template, open a panel…). */
  before?: () => void | Promise<void>;
}

export interface Lesson {
  /** Unique, stable (kept in the person's progress): `designer.draw.rect`. */
  id: string;
  cat: Cat;
  /** Its chapter (chapters.ts). */
  chapter: string;
  title: Text;
  setup: Setup;
  steps: Step[];
}
