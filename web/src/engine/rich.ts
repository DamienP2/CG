// Rich text: parts of a typed text in bold, italic, underlined, struck
// through or in another colour. Mirror of crates/cg-core/src/rich.rs.
//
//   <b>bold</b> <i>italic</i> <u>underlined</u> <s>struck</s> <c=#ff3b5c>red</c>
//
// Tags nest; anything else that looks like a tag stays text. A {{key}} takes
// the style around it. Only what people type is styled: the Designer's text
// and the values the operator types (`rich` keys); the values of the data
// sources never add styles.
import { createContext } from 'react';
import { interpolateText } from './evaluate';
import type { Data, Template } from './types';

export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** #rrggbb[aa]; unset = the colour of the text. */
  color?: string;
}
export interface Run {
  text: string;
  style: RunStyle;
}

type Tag = { open: boolean; t: string; v?: string; len: number };
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function tagAt(s: string): Tag | null {
  for (const t of ['b', 'i', 'u', 's']) if (s.startsWith(`<${t}>`)) return { open: true, t, len: 3 };
  const end = s.indexOf('>');
  if (end < 0) return null;
  const inner = s.slice(1, end);
  if (/^\/[biusc]$/.test(inner)) return { open: false, t: inner[1], len: end + 1 };
  if (inner.startsWith('c=') && HEX.test(inner.slice(2))) return { open: true, t: 'c', v: inner.slice(2), len: end + 1 };
  return null;
}

export const hasMarkup = (s: string) => {
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) if (tagAt(s.slice(i))) return true;
  return false;
};

const same = (a: RunStyle, b: RunStyle) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.strike === !!b.strike && (a.color ?? '') === (b.color ?? '');

/** The parts of `markup` with their style. */
export function parse(markup: string): Run[] {
  const runs: Run[] = [];
  const stack: { t: string; v?: string }[] = [];
  const style = (): RunStyle => {
    const s: RunStyle = {};
    for (const { t, v } of stack) {
      if (t === 'b') s.bold = true;
      else if (t === 'i') s.italic = true;
      else if (t === 'u') s.underline = true;
      else if (t === 's') s.strike = true;
      else s.color = v;
    }
    return s;
  };
  let cur = '';
  const flush = () => {
    if (!cur) return;
    const st = style();
    const last = runs[runs.length - 1];
    if (last && same(last.style, st)) last.text += cur;
    else runs.push({ text: cur, style: st });
    cur = '';
  };
  let rest = markup;
  for (let i = rest.indexOf('<'); i >= 0; i = rest.indexOf('<')) {
    cur += rest.slice(0, i);
    const at = rest.slice(i);
    const tag = tagAt(at);
    if (!tag) {
      cur += '<';
      rest = at.slice(1);
      continue;
    }
    flush();
    if (tag.open) stack.push({ t: tag.t, v: tag.v });
    else {
      const p = stack.map((x) => x.t).lastIndexOf(tag.t);
      if (p >= 0) stack.splice(p, 1);
    }
    rest = at.slice(tag.len);
  }
  cur += rest;
  flush();
  return runs;
}

/** The text without its tags. */
export const plain = (markup: string) =>
  parse(markup)
    .map((r) => r.text)
    .join('');

/** The parts as shown (mirror of rich::runs); null without style tags. */
export function runs(markup: string, data: Data, rich: (key: string) => boolean, kase: (s: string) => string): Run[] | null {
  // The operator's styled values first, as if typed in the text.
  const expanded = markup.replace(/\{\{([^}]*)\}\}/g, (m, k: string) => (rich(k.trim()) && data[k.trim()] !== undefined ? data[k.trim()] : m));
  if (!hasMarkup(expanded)) return null;
  const out = parse(expanded).map((r) => ({ text: interpolateText(r.text, data), style: r.style }));
  const whole = out.map((r) => r.text).join('');
  const cased = kase(whole);
  if ([...cased].length === [...whole].length) {
    const chars = [...cased];
    let at = 0;
    for (const r of out) {
      const n = [...r.text].length;
      r.text = chars.slice(at, at + n).join('');
      at += n;
    }
  } else for (const r of out) r.text = kase(r.text);
  return out.filter((r) => r.text);
}

const space = (c: string | undefined) => c === ' ' || c === ' ' || c === ' ' || c === '\n' || c === '\t';

/** The parts of each shown line, as [text, index of the run] (mirror of rich::align). */
export function align(rs: Run[], lines: string[]): [string, number][][] {
  const chars: [string, number][] = rs.flatMap((r, i) => [...r.text].map((c) => [c, i] as [string, number]));
  let at = 0;
  return lines.map((line) => {
    const parts: [string, number][] = [];
    for (const ch of line) {
      if (!space(ch)) {
        let j = at;
        while (j < chars.length && chars[j][0] !== ch && space(chars[j][0])) j++;
        if (j < chars.length && chars[j][0] === ch) at = j;
      }
      let run: number;
      if (at < chars.length && (chars[at][0] === ch || (space(ch) && space(chars[at][0])))) run = chars[at++][1];
      else run = chars[Math.max(0, at - 1)]?.[1] ?? 0;
      const last = parts[parts.length - 1];
      if (last && last[1] === run) last[0] += ch;
      else parts.push([ch, run]);
    }
    return parts;
  });
}

/** Keys whose values the operator types (they may have styles). */
export const typedKeys = (t: Pick<Template, 'fields'> | null | undefined) => {
  const keys = new Set((t?.fields ?? []).filter((f) => !f.binding).map((f) => f.key));
  return (k: string) => keys.has(k);
};

/** The template's typed keys, for the texts drawn inside it (set by Scene). */
export const RichKeys = createContext<(key: string) => boolean>(() => false);

/** Whether the operator can style the value of `key` (typed, and only shown in Texts). */
export function richField(t: Pick<Template, 'fields' | 'layers'>, key: string): boolean {
  const f = t.fields.find((x) => x.key === key);
  if (!f || f.binding || (f.kind !== 'text' && f.kind !== 'multiline')) return false;
  const token = `{{${key}}}`;
  const users = t.layers.filter((l) => JSON.stringify(l).includes(token));
  return users.length > 0 && users.every((l) => l.type === 'text' && l.text.includes(token) && !JSON.stringify({ ...l, text: '' }).includes(token));
}
