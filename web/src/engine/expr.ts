// The expressions of the Logic canvas — mirror of crates/cg-core/src/logic/expr.rs.
// A Calculation (`a + b`, `format(a, 1) & " %"`), the conditions of an If (`a > b et c = "OUI"`) and its values.

export type LVal = number | string;

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'text'; v: string }
  | { k: 'name'; v: string }
  | { k: 'neg'; a: Expr }
  | { k: 'not'; a: Expr }
  | { k: 'bin'; op: Op; a: Expr; b: Expr }
  | { k: 'call'; f: string; args: Expr[] };

type Op = '+' | '-' | '*' | '/' | '%' | '^' | '&' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'et' | 'ou';

type Tok = { t: 'num'; v: number } | { t: 'text'; v: string } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: '(' } | { t: ')' } | { t: ',' };

/** A name in lower case without accents (« Arrondi » = « arrondi »). */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function lex(s: string): Tok[] {
  const c = [...s];
  const out: Tok[] = [];
  let i = 0;
  const isDigit = (x: string | undefined) => !!x && x >= '0' && x <= '9';
  const isAlpha = (x: string) => /[\p{L}_]/u.test(x);
  const isAlnum = (x: string) => /[\p{L}\p{N}_]/u.test(x);
  while (i < c.length) {
    const ch = c[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(c[i + 1]))) {
      const start = i;
      while (i < c.length && (isDigit(c[i]) || c[i] === '.')) i++;
      const t = c.slice(start, i).join('');
      const v = Number(t);
      if (!Number.isFinite(v)) throw new Error(`nombre « ${t} »`);
      out.push({ t: 'num', v });
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '«' || ch === '“') {
      const end = ch === '«' ? '»' : ch === '“' ? '”' : ch;
      const start = ++i;
      while (i < c.length && c[i] !== end) i++;
      if (i >= c.length) throw new Error('texte non fermé');
      const t = c.slice(start, i).join('');
      // « OUI » : the spaces inside French quotes are not part of the text.
      out.push({ t: 'text', v: ch === '«' ? t.trim() : t });
      i++;
      continue;
    }
    if (isAlpha(ch)) {
      const start = i;
      while (i < c.length && isAlnum(c[i])) i++;
      const w = c.slice(start, i).join('');
      const f = fold(w);
      if (f === 'et' || f === 'and') out.push({ t: 'op', v: 'et' });
      else if (f === 'ou' || f === 'or') out.push({ t: 'op', v: 'ou' });
      else if (f === 'non' || f === 'not') out.push({ t: 'op', v: 'non' });
      else out.push({ t: 'name', v: w });
      continue;
    }
    const two = c.slice(i, i + 2).join('');
    const op2 = ({ '==': '=', '!=': '!=', '<>': '!=', '<=': '<=', '>=': '>=', '&&': 'et', '||': 'ou' } as Record<string, string>)[two];
    if (op2) {
      out.push({ t: 'op', v: op2 });
      i += 2;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ t: ch });
      i++;
      continue;
    }
    if (ch === ',' || ch === ';') {
      out.push({ t: ',' });
      i++;
      continue;
    }
    const op1 = ({ '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '/': '/', '÷': '/', '%': '%', '^': '^', '&': '&', '=': '=', '≠': '!=', '<': '<', '>': '>', '≤': '<=', '≥': '>=', '!': 'non' } as Record<string, string>)[ch];
    if (!op1) throw new Error(`caractère « ${ch} »`);
    out.push({ t: 'op', v: op1 });
    i++;
  }
  return out;
}

/** The functions, by French and English name. */
export const FUNCTIONS: [string, string][] = [
  ['min', 'min'],
  ['max', 'max'],
  ['abs', 'abs'],
  ['arrondi', 'round'],
  ['plancher', 'floor'],
  ['plafond', 'ceil'],
  ['limiter', 'clamp'],
  ['remapper', 'remap'],
  ['racine', 'sqrt'],
  ['puissance', 'pow'],
  ['si', 'if'],
  ['vide', 'empty'],
  ['longueur', 'len'],
  ['majuscules', 'upper'],
  ['minuscules', 'lower'],
  ['capitaliser', 'capitalize'],
  ['nettoyer', 'trim'],
  ['contient', 'contains'],
  ['commence', 'startswith'],
  ['finit', 'endswith'],
  ['remplacer', 'replace'],
  ['ligne', 'line'],
  ['gauche', 'left'],
  ['droite', 'right'],
  ['format', 'fmt'],
  ['compact', 'short'],
  ['pluriel', 'plural'],
  ['nombre', 'num'],
  ['texte', 'text'],
  ['entre', 'between'],
  ['temps', 'time'],
  ['heure', 'hour'],
  ['minute', 'minutes'],
  ['seconde', 'seconds'],
  ['osciller', 'osc'],
  ['clignoter', 'blink'],
  ['melanger', 'mix'],
];
const KNOWN = new Set(FUNCTIONS.flat());

class Parser {
  i = 0;
  constructor(private t: Tok[]) {}
  peek() {
    return this.t[this.i];
  }
  op(ops: string[]): string | undefined {
    const p = this.peek();
    if (p?.t === 'op' && ops.includes(p.v)) {
      this.i++;
      return p.v;
    }
    return undefined;
  }
  or(): Expr {
    let a = this.and();
    while (this.op(['ou'])) a = { k: 'bin', op: 'ou', a, b: this.and() };
    return a;
  }
  and(): Expr {
    let a = this.not();
    while (this.op(['et'])) a = { k: 'bin', op: 'et', a, b: this.not() };
    return a;
  }
  not(): Expr {
    if (this.op(['non'])) return { k: 'not', a: this.not() };
    return this.cmp();
  }
  cmp(): Expr {
    const a = this.join();
    const o = this.op(['=', '!=', '<', '<=', '>', '>=']);
    return o ? { k: 'bin', op: o as Op, a, b: this.join() } : a;
  }
  join(): Expr {
    let a = this.add();
    while (this.op(['&'])) a = { k: 'bin', op: '&', a, b: this.add() };
    return a;
  }
  add(): Expr {
    let a = this.mul();
    for (let o = this.op(['+', '-']); o; o = this.op(['+', '-'])) a = { k: 'bin', op: o as Op, a, b: this.mul() };
    return a;
  }
  mul(): Expr {
    let a = this.unary();
    for (let o = this.op(['*', '/', '%']); o; o = this.op(['*', '/', '%'])) a = { k: 'bin', op: o as Op, a, b: this.unary() };
    return a;
  }
  unary(): Expr {
    if (this.op(['-'])) return { k: 'neg', a: this.unary() };
    if (this.op(['+'])) return this.unary();
    const a = this.primary();
    if (this.op(['^'])) return { k: 'bin', op: '^', a, b: this.unary() };
    return a;
  }
  primary(): Expr {
    const t = this.t[this.i++];
    if (!t) throw new Error('expression incomplète');
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case 'text':
        return { k: 'text', v: t.v };
      case '(': {
        const e = this.or();
        if (this.peek()?.t !== ')') throw new Error('parenthèse non fermée');
        this.i++;
        return e;
      }
      case 'name': {
        if (this.peek()?.t === '(') {
          this.i++;
          const args: Expr[] = [];
          const f = fold(t.v);
          if (this.peek()?.t === ')') {
            this.i++;
            return { k: 'call', f, args };
          }
          for (;;) {
            args.push(this.or());
            const p = this.peek();
            if (p?.t === ',') this.i++;
            else if (p?.t === ')') {
              this.i++;
              break;
            } else throw new Error('parenthèse non fermée');
          }
          if (!KNOWN.has(f)) throw new Error(`fonction inconnue « ${t.v} »`);
          return { k: 'call', f, args };
        }
        const f = fold(t.v);
        if (f === 'vrai' || f === 'true') return { k: 'num', v: 1 };
        if (f === 'faux' || f === 'false') return { k: 'num', v: 0 };
        return { k: 'name', v: t.v };
      }
      case 'op':
        throw new Error(`« ${t.v} » inattendu`);
      case ')':
        throw new Error('« ) » inattendu');
      default:
        throw new Error('« , » inattendue');
    }
  }
}

const cache = new Map<string, Expr | string>();

/** Parses an expression; a string is the error, in French. */
export function parse(s: string): Expr | string {
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  let out: Expr | string;
  try {
    const toks = lex(s);
    if (!toks.length) out = { k: 'text', v: '' };
    else {
      const p = new Parser(toks);
      const e = p.or();
      out = p.i < toks.length ? 'expression en trop' : e;
    }
  } catch (e) {
    out = (e as Error).message;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(s, out);
  return out;
}

/** The error of an expression, if any. */
export const exprError = (s: string) => {
  const e = parse(s);
  return typeof e === 'string' ? e : undefined;
};

/** The inputs an expression reads (its names), in order. */
export function names(e: Expr | string, out: string[] = []): string[] {
  if (typeof e === 'string') return out;
  switch (e.k) {
    case 'name':
      if (!out.includes(e.v)) out.push(e.v);
      break;
    case 'neg':
    case 'not':
      names(e.a, out);
      break;
    case 'bin':
      names(e.a, out);
      names(e.b, out);
      break;
    case 'call':
      for (const a of e.args) names(a, out);
  }
  return out;
}

export interface Clock {
  /** Seconds since the graphic came in. */
  secs: number;
  /** The clock, ms since 1970. */
  nowMs: number;
}

let zoneFmt: Intl.DateTimeFormat | null = null;

/** The time zone of `heure()`, `minute()`, `seconde()`: the server's setting, as on air. */
export function setDefaultTz(tz: string) {
  try {
    zoneFmt = tz ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }) : null;
  } catch {
    zoneFmt = null;
  }
}

/** Hours, minutes and seconds of `ms` in that zone. */
function wallClock(ms: number) {
  if (!zoneFmt) return new Date(ms);
  const p = Object.fromEntries(zoneFmt.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return { getHours: () => p.hour ?? 0, getMinutes: () => p.minute ?? 0, getSeconds: () => p.second ?? 0 };
}

/** A text read as a number, when it is one (`12`, `-3,5`, ` 4.0 `). */
export function asNumber(v: LVal): number | undefined {
  if (typeof v === 'number') return v;
  const t = v.trim();
  if (!t || !/^[-+]?(\d+[.,]?\d*|[.,]\d+)(e[-+]?\d+)?$/i.test(t)) return undefined;
  const x = Number(t.replace(',', '.'));
  return Number.isFinite(x) ? x : undefined;
}

export const toNum = (v: LVal) => asNumber(v) ?? 0;

/** A number as a text shows it: whole, or with at most 2 decimals (cg_core::logic::format_number). */
export const formatNumber = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '');

export const text = (v: LVal) => (typeof v === 'number' ? formatNumber(v) : v);

export function truthy(v: LVal | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  const t = fold(v.trim());
  return !!t && t !== '0' && t !== 'false' && t !== 'faux' && t !== 'non';
}

const b = (x: boolean) => (x ? 1 : 0);

function compare(a: LVal, c: LVal): number {
  const x = asNumber(a);
  const y = asNumber(c);
  if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0;
  const p = text(a).trim().toLowerCase();
  const q = text(c).trim().toLowerCase();
  return p < q ? -1 : p > q ? 1 : 0;
}

/** `x` the French way: `decimals` after a comma, thin spaces between thousands. */
export function formatFr(x: number, decimals: number, grouping: boolean): string {
  if (!Number.isFinite(x)) return '';
  const s = Math.abs(x).toFixed(decimals);
  const [int, frac = ''] = s.split('.');
  let g = '';
  for (let i = 0; i < int.length; i++) {
    if (grouping && i > 0 && (int.length - i) % 3 === 0) g += ' ';
    g += int[i];
  }
  const neg = x < 0 && /[1-9]/.test(s);
  return `${neg ? '-' : ''}${g}${frac ? `,${frac}` : ''}`;
}

/** 1 234 → « 1,2 k », 3 400 000 → « 3,4 M ». */
export function short(x: number): string {
  const a = Math.abs(x);
  const [v, unit] = a >= 1e9 ? [x / 1e9, ' Md'] : a >= 1e6 ? [x / 1e6, ' M'] : a >= 1e3 ? [x / 1e3, ' k'] : [x, ''];
  const r = Math.round(v * 10) / 10;
  return `${formatFr(r, Number.isInteger(r) ? 0 : 1, false)}${unit}`;
}

function hex(c: string): number[] | undefined {
  const h = c.trim().replace(/^#/, '');
  const p = (i: number, s = h) => parseInt(s.slice(i, i + 2), 16);
  if (/^[0-9a-f]{6}$/i.test(h)) return [p(0), p(2), p(4), 255];
  if (/^[0-9a-f]{8}$/i.test(h)) return [p(0), p(2), p(4), p(6)];
  if (/^[0-9a-f]{3}$/i.test(h)) {
    const d = h
      .split('')
      .map((x) => x + x)
      .join('');
    return [p(0, d), p(2, d), p(4, d), 255];
  }
  return undefined;
}

const fin = (x: number) => (Number.isFinite(x) ? x : 0);

function call(f: string, args: Expr[], get: (n: string) => LVal, clock: Clock): LVal {
  if (f === 'si' || f === 'if') {
    const c = args[0] ? truthy(evalExpr(args[0], get, clock)) : false;
    const pick = c ? args[1] : args[2];
    return pick ? evalExpr(pick, get, clock) : '';
  }
  const v = args.map((a) => evalExpr(a, get, clock));
  const n = (i: number) => (i < v.length ? toNum(v[i]) : 0);
  const s = (i: number) => (i < v.length ? text(v[i]) : '');
  const has = (i: number) => i < v.length;
  const d = wallClock(clock.nowMs);
  switch (f) {
    case 'min':
      return fin(Math.min(...v.map(toNum)));
    case 'max':
      return fin(Math.max(...v.map(toNum)));
    case 'abs':
      return Math.abs(n(0));
    case 'arrondi':
    case 'round': {
      const k = 10 ** Math.min(10, Math.max(0, Math.round(n(1))));
      return Math.round(n(0) * k) / k;
    }
    case 'plancher':
    case 'floor':
      return Math.floor(n(0));
    case 'plafond':
    case 'ceil':
      return Math.ceil(n(0));
    case 'limiter':
    case 'clamp':
      return Math.min(Math.max(n(0), n(1)), Math.max(n(2), n(1)));
    case 'remapper':
    case 'remap': {
      const [a, b2, c, dd] = [n(1), n(2), n(3), n(4)];
      if (b2 === a) return c;
      const k = Math.min(1, Math.max(0, (n(0) - a) / (b2 - a)));
      return c + (dd - c) * k;
    }
    case 'racine':
    case 'sqrt':
      return Math.sqrt(Math.max(0, n(0)));
    case 'puissance':
    case 'pow':
      return fin(n(0) ** n(1));
    case 'vide':
    case 'empty':
      return b(!has(0) || !text(v[0]).trim());
    case 'longueur':
    case 'len':
      return [...s(0)].length;
    case 'majuscules':
    case 'upper':
      return s(0).toUpperCase();
    case 'minuscules':
    case 'lower':
      return s(0).toLowerCase();
    case 'capitaliser':
    case 'capitalize':
      return s(0)
        .split(' ')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''))
        .join(' ');
    case 'nettoyer':
    case 'trim':
      return s(0).trim();
    case 'contient':
    case 'contains':
      return b(s(0).toLowerCase().includes(s(1).toLowerCase()));
    case 'commence':
    case 'startswith':
      return b(s(0).toLowerCase().startsWith(s(1).toLowerCase()));
    case 'finit':
    case 'endswith':
      return b(s(0).toLowerCase().endsWith(s(1).toLowerCase()));
    case 'remplacer':
    case 'replace':
      return s(1) ? s(0).split(s(1)).join(s(2)) : s(0);
    case 'ligne':
    case 'line':
      return s(0).split('\n')[Math.max(1, Math.round(n(1))) - 1] ?? '';
    case 'gauche':
    case 'left':
      return [...s(0)].slice(0, Math.max(0, Math.trunc(n(1)))).join('');
    case 'droite':
    case 'right': {
      const t = [...s(0)];
      const k = Math.min(Math.max(0, Math.trunc(n(1))), t.length);
      return t.slice(t.length - k).join('');
    }
    case 'format':
    case 'fmt':
      return formatFr(n(0), has(1) ? Math.min(6, Math.max(0, Math.round(n(1)))) : 0, !has(2) || truthy(v[2]));
    case 'compact':
    case 'short':
      return short(n(0));
    case 'pluriel':
    case 'plural':
      return Math.abs(n(0)) >= 2 ? s(2) : s(1);
    case 'nombre':
    case 'num':
      return asNumber(v[0] ?? 0) ?? 0;
    case 'texte':
    case 'text':
      return s(0);
    case 'entre':
    case 'between': {
      const lo = Math.min(n(1), n(2));
      const hi = Math.max(n(1), n(2));
      return b(n(0) >= lo && n(0) <= hi);
    }
    case 'temps':
    case 'time':
      return clock.secs;
    case 'heure':
    case 'hour':
      return d.getHours();
    case 'minute':
    case 'minutes':
      return d.getMinutes();
    case 'seconde':
    case 'seconds':
      return d.getSeconds();
    case 'osciller':
    case 'osc': {
      const p = has(0) && n(0) > 0 ? n(0) : 1;
      return 0.5 - 0.5 * Math.cos((2 * Math.PI * clock.secs) / p);
    }
    case 'clignoter':
    case 'blink': {
      const p = has(0) && n(0) > 0 ? n(0) : 1;
      const k = clock.secs / p;
      return b(k - Math.floor(k) < 0.5);
    }
    case 'melanger':
    case 'mix': {
      const a = hex(s(0));
      const c = hex(s(1));
      if (!a || !c) return s(0);
      const k = Math.min(1, Math.max(0, n(2)));
      const m = a.map((x, i) => Math.round(x + (c[i] - x) * k));
      const h = (x: number) => x.toString(16).padStart(2, '0');
      return `#${h(m[0])}${h(m[1])}${h(m[2])}${m[3] === 255 ? '' : h(m[3])}`;
    }
  }
  return '';
}

/** The value of `e`, its names read with `get`. */
export function evalExpr(e: Expr, get: (n: string) => LVal, clock: Clock): LVal {
  switch (e.k) {
    case 'num':
    case 'text':
      return e.v;
    case 'name':
      return get(e.v);
    case 'neg':
      return -toNum(evalExpr(e.a, get, clock));
    case 'not':
      return b(!truthy(evalExpr(e.a, get, clock)));
    case 'call':
      return call(e.f, e.args, get, clock);
    case 'bin': {
      if (e.op === 'et') return b(truthy(evalExpr(e.a, get, clock)) && truthy(evalExpr(e.b, get, clock)));
      if (e.op === 'ou') return b(truthy(evalExpr(e.a, get, clock)) || truthy(evalExpr(e.b, get, clock)));
      const a = evalExpr(e.a, get, clock);
      const c = evalExpr(e.b, get, clock);
      switch (e.op) {
        case '+': {
          const x = asNumber(a);
          const y = asNumber(c);
          if (x !== undefined && y !== undefined) return x + y;
          if ((typeof a === 'string' && a.trim()) || (typeof c === 'string' && c.trim())) return text(a) + text(c);
          return toNum(a) + toNum(c);
        }
        case '-':
          return toNum(a) - toNum(c);
        case '*':
          return toNum(a) * toNum(c);
        case '/':
          return toNum(c) === 0 ? 0 : toNum(a) / toNum(c);
        case '%': {
          const m = toNum(c);
          return m === 0 ? 0 : ((toNum(a) % m) + Math.abs(m)) % Math.abs(m);
        }
        case '^':
          return fin(toNum(a) ** toNum(c));
        case '&':
          return text(a) + text(c);
        case '=':
          return b(compare(a, c) === 0);
        case '!=':
          return b(compare(a, c) !== 0);
        case '<':
          return b(compare(a, c) < 0);
        case '<=':
          return b(compare(a, c) <= 0);
        case '>':
          return b(compare(a, c) > 0);
        case '>=':
          return b(compare(a, c) >= 0);
      }
    }
  }
  return '';
}

/** Parses and evaluates `s` (empty on an error). */
export function runExpr(s: string, get: (n: string) => LVal, clock: Clock): LVal {
  const e = parse(s);
  return typeof e === 'string' ? '' : evalExpr(e, get, clock);
}

/** The expression uses the time (temps(), osciller()…): it changes on its own. */
export const usesTime = (s: string) => /\b(temps|time|heure|hour|minutes?|secondes?|seconds|osciller|osc|clignoter|blink)\s*\(/i.test(fold(s));
