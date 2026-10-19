// Timer: clock, date, stopwatch and countdown — settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/timer.rs; logic mirrored in ./timer-fmt.ts
// (crates/cg-core/src/wid/timer.rs); actions in crates/cg-core/src/wid/timer.rs.
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Timer } from 'lucide-react';
import { col, cssColor, num, type Resolved } from '../engine/evaluate';
import { textWidth } from '../engine/widgets';
import type { Data, Layer, FontStyle } from '../engine/types';
import { ColorGroupRow, FontControls, GroupRow } from '../designer/Inspector';
import { useApp } from '../store';
import { confirmDialog } from '../ui/dialogs';
import { Btns, ColorPick, Content, defineWidget, hex, ListEditor, Msg, Note, Range, Row, Section, Seg, Select, Text, Toggle, useFrame, useKeys, type Warning } from './kit';
import * as T from './timer-fmt';

export type Config = T.Config;
export type State = T.State;
type L = T.ClockLayer;

const ZONES = ['Europe/Paris', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Dubai', 'Asia/Kolkata', 'Australia/Sydney', 'UTC'];
const PRESETS: Record<T.TimerMode, [string, T.DateCase?][]> = {
  clock: [['HH:mm:ss'], ['HH:mm'], ['H[h]mm'], ['HH:mm:ss:FF'], ['dddd HH:mm']],
  date: [['dddd D MMMM YYYY', 'first'], ['DD/MM/YYYY'], ['D MMM', 'upper'], ['ddd D MMM', 'upper'], ['YYYY-MM-DD']],
  stopwatch: [['mm:ss'], ['HH:mm:ss'], ['mm:ss.S'], ['mm:ss.SS'], ['HH:mm:ss:FF']],
  countdown: [['mm:ss'], ['HH:mm:ss'], ['mm:ss.S'], ['DD[d] HH:mm:ss'], ['[J-]D']],
};
const MODES: [T.TimerMode, string][] = [
  ['clock', 'Clock'],
  ['date', 'Date'],
  ['stopwatch', 'Stopwatch'],
  ['countdown', 'Countdown'],
];
const LEGACY_MODE: Record<T.TimerMode, string> = { clock: 'time', date: 'time', stopwatch: 'elapsed', countdown: 'timer' };
const STEPS: Partial<Record<T.TimerMode, T.Step[]>> = {
  countdown: [
    { on: true, at: 60, color: '#f59e0b', bg: '', blink: false },
    { on: true, at: 10, color: '#ff3b5c', bg: '', blink: true },
  ],
  stopwatch: [{ on: true, at: 2700, color: '#facc15', bg: '', blink: false }],
};
const LH = 1.2;

// ------------------------------------------------------------- layout --

interface Piece {
  text: string;
  w: number;
  cell: boolean;
  alpha: number;
}
const cellW = (fam: string, wt: number, size: number) => Math.max(...'0123456789'.split('').map((d) => textWidth(d, fam, wt, size, 0)));

function pieces(segs: T.Seg[], sep: string, fam: string, wt: number, size: number, ls: number, tabular: boolean, sepAlpha: number, upper: boolean): Piece[] {
  const out: Piece[] = [];
  const push = (text: string, cell: boolean, alpha: number) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && !cell && !last.cell && last.alpha === alpha) return void (last.text += text);
    out.push({ text, w: 0, cell, alpha });
  };
  for (const g of segs) {
    let t = g.k === 'sep' ? sep : g.t;
    if (upper) t = t.toUpperCase();
    const alpha = g.k === 'sep' ? sepAlpha : 1;
    if (tabular) {
      let run = '';
      for (const ch of t) {
        if (/[0-9]/.test(ch)) {
          push(run, false, alpha);
          run = '';
          push(ch, true, alpha);
        } else run += ch;
      }
      push(run, false, alpha);
    } else push(t, false, alpha);
  }
  const cw = tabular ? cellW(fam, wt, size) : 0;
  for (const p of out) p.w = p.cell ? cw : textWidth(p.text, fam, wt, size, ls);
  return out;
}
const width = (ps: Piece[]) => ps.reduce((a, p) => a + p.w, 0);

interface Plate {
  disp: T.Disp;
  label: string;
  wi: number;
  wp: number;
  ws: number;
}

const fontCss = (fam: string) => `"${fam}", Inter, system-ui, sans-serif`;

function TimerView({ layer, r, w, h, data, time, state, fps, designer }: { layer: L; r: Resolved; w: number; h: number; data: Data; time: { nowMs: number; ageSecs: number; defaultTz: string }; state: unknown; fps: number; designer?: boolean }) {
  const e = T.eff(layer, data);
  const c = e.c;
  const now = time.nowMs;
  const at: T.At = { now, ageMs: time.ageSecs * 1000, fps, defaultTz: time.defaultTz };
  const size = Math.max(1, num(r.fontSize));
  const fam = layer.fontFamily;
  const wt = layer.fontWeight;
  const ls = num(r.letterSpacing);
  const upper = !!layer.uppercase;
  const [prefix, suffix] = T.affixes(c, data);
  const sepAlpha = c.sepBlink && ((now % 1000) + 1000) % 1000 >= 500 ? 0.12 : 1;
  const st = state as State | undefined;
  const zones: [T.ZoneSel | undefined, string][] =
    !T.timed(e) && c.cities && c.cityList.length
      ? c.cityList.map((ct) => {
          const label = ct.label?.trim() ? ct.label : (ct.zone ?? '');
          return [T.zoneNamed(ct.zone), c.affix.upper ? label.toUpperCase() : label];
        })
      : [[undefined, '']];
  const afam = fam;
  const asz = (k: number) => (size * k * c.affix.size) / 100;
  const aw = (s: string) => (s ? textWidth(s, afam, c.affix.weight, asz(1), 0) : 0);
  const plates: Plate[] = zones.map(([z, label]) => {
    const disp = T.display(e, st, at, z);
    const wv = width(pieces(disp.segs, c.sep, fam, wt, size, ls, c.tabular, 1, upper));
    const wi = c.reserve ? Math.max(wv, ...T.widest(e, disp, c.sep, fps).map((s) => width(pieces([{ k: 'lit', t: s }], c.sep, fam, wt, size, ls, c.tabular, 1, upper)))) : wv;
    return { disp, label, wi, wp: aw(prefix), ws: aw(suffix) };
  });
  if (plates.every((p) => p.disp.hidden)) return null;
  const pad = (k: number): [number, number, number] => {
    const p = c.plate;
    if (!p.on) return [0, 0, 0];
    const py = Math.max(p.padY * k, size * k * 0.08);
    return [(p.padX + (p.accent ? 12 : 0)) * k, p.padX * k, py];
  };
  const gap = (k: number) => size * k * 0.14;
  const contentW = (pl: Plate, k: number) => pl.wi * k + (pl.wp > 0 ? pl.wp * k + gap(k) : 0) + (pl.ws > 0 ? pl.ws * k + gap(k) : 0);
  const plateW = (pl: Plate, k: number) => {
    const [l, rr] = pad(k);
    return l + contentW(pl, k) + rr;
  };
  const plateH = (k: number) => size * k * LH + 2 * pad(k)[2];
  const labelH = (pl: Plate, k: number) => (pl.label ? asz(k) * LH + size * k * 0.12 : 0);
  const n = plates.length;
  const total1 = plates.reduce((a, p) => a + plateW(p, 1), 0) + (n - 1) * 36;
  const k = c.fit && total1 > 0 ? Math.min(1, Math.max(0.01, (w - 8) / total1)) : 1;
  const total = plates.reduce((a, p) => a + plateW(p, k), 0) + (n - 1) * 36 * k;
  const labH = Math.max(...plates.map((p) => labelH(p, k)));
  const groupH = labH + plateH(k);
  const x0 = layer.align === 'left' ? 0 : layer.align === 'right' ? w - total : (w - total) / 2;
  const y0 = layer.verticalAlign === 'top' ? 0 : layer.verticalAlign === 'bottom' ? h - groupH : (h - groupH) / 2;
  const fill = cssColor(col(r.fill));
  const affixCol = c.affix.color.trim() ? hex(c.affix.color) : fill;
  const strokeW = num(r.strokeWidth);
  const strokeCss = strokeW > 0 ? `${strokeW}px ${cssColor(col(r.stroke))}` : undefined;
  const els: ReactNode[] = [];
  const textBox = (key: string, text: string, x: number, cy: number, sz: number, style: CSSProperties) => (
    <div key={key} style={{ position: 'absolute', left: x, top: cy - (sz * LH) / 2, height: sz * LH, lineHeight: LH, fontSize: sz, whiteSpace: 'pre', fontKerning: 'normal', ...style }}>
      {text}
    </div>
  );
  let x = x0;
  plates.forEach((pl, i) => {
    const pw = plateW(pl, k);
    const ph = plateH(k);
    const y = y0 + labH;
    const cy = y + ph / 2;
    const sz = size * k;
    const d = pl.disp;
    if (!d.hidden) {
      const bg = d.bg ? hex(d.bg) : c.plate.on ? hex(c.plate.color) : null;
      if (bg) {
        const px = c.plate.on ? 0 : c.plate.padX * k;
        const pyy = c.plate.on ? 0 : Math.max(c.plate.padY * k, sz * 0.08);
        const rad = c.plate.radius * k;
        els.push(
          <div key={`bg${i}`} style={{ position: 'absolute', left: x - px, top: y - pyy, width: pw + 2 * px, height: ph + 2 * pyy, borderRadius: rad, background: bg, overflow: 'hidden', boxShadow: c.plate.shadow && c.plate.on ? `0 ${18 * k}px ${50 * k}px rgba(0,0,0,.45)` : undefined }}>
            {c.plate.on && c.plate.accent && <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: Math.max(8, sz * 0.08), background: hex(c.plate.accentColor) }} />}
          </div>,
        );
      }
      const blinkOff = d.blink && ((now % 1000) + 1000) % 1000 >= 600;
      const valAlpha = blinkOff ? 0.15 : 1;
      const textCol = d.color ? hex(d.color) : fill;
      let ix = x + pad(k)[0];
      const affix = (key: string, s: string, ax: number) => textBox(key, s, ax, cy, asz(k), { color: affixCol, fontFamily: fontCss(afam), fontWeight: c.affix.weight });
      if (pl.wp > 0) {
        els.push(affix(`p${i}`, prefix, ix));
        ix += pl.wp * k + gap(k);
      }
      const ps = pieces(d.segs, c.sep, fam, wt, sz, ls * k, c.tabular, sepAlpha, upper);
      const wv = width(ps);
      const wi = pl.wi * k;
      const off = layer.align === 'left' ? 0 : layer.align === 'right' ? wi - wv : (wi - wv) / 2;
      if (designer && c.reserve && c.guide)
        els.push(<i key={`g${i}`} title="Reserved width" style={{ position: 'absolute', left: ix - 6, top: cy - (sz * LH) / 2 - 4, width: wi + 12, height: sz * LH + 8, border: '2px dashed rgba(255,255,255,.22)', borderRadius: 8, boxSizing: 'border-box', pointerEvents: 'none' }} />);
      let vx = ix + off;
      ps.forEach((p, j) => {
        const st: CSSProperties = { color: textCol, opacity: p.alpha * valAlpha, fontFamily: fontCss(fam), fontWeight: wt, letterSpacing: p.cell ? 0 : ls * k, WebkitTextStroke: strokeCss };
        if (p.cell) Object.assign(st, { width: p.w, textAlign: 'center' });
        els.push(textBox(`v${i}-${j}`, p.text, vx, cy, sz, st));
        vx += p.w;
      });
      ix += wi;
      if (pl.ws > 0) els.push(affix(`s${i}`, suffix, ix + gap(k)));
      if (pl.label) els.push(textBox(`l${i}`, pl.label, x, y - labelH(pl, k) + (asz(k) * LH) / 2, asz(k), { width: pw, textAlign: 'center', color: affixCol, fontFamily: fontCss(afam), fontWeight: c.affix.weight }));
      if (d.split) {
        const bs = Math.max(18, sz * 0.16);
        const bw = textWidth('SPLIT', 'Inter', 900, bs, 0) + 24;
        const bh = bs * LH + 6;
        els.push(
          <div key={`sp${i}`} style={{ position: 'absolute', left: x + pw - 18 - bw, top: y - sz * 0.22, width: bw, height: bh, lineHeight: `${bh}px`, borderRadius: 6, background: '#facc15', color: '#1a1200', font: `900 ${bs}px Inter, system-ui, sans-serif`, textAlign: 'center' }}>
            SPLIT
          </div>,
        );
      }
    }
    x += pw + 36 * k;
  });
  const b = plates[0] && T.banner(e, plates[0].disp, now);
  if (b) {
    const [sc, alpha] = b;
    const bs = 64 * k;
    const bw = textWidth(c.bannerText, 'Inter', 900, bs, 0) + 80 * k;
    const bh = bs * LH + 28 * k;
    els.push(
      <div
        key="banner"
        style={{
          position: 'absolute',
          left: x0 + total / 2 - bw / 2,
          top: y0 + groupH + 22 * k,
          width: bw,
          height: bh,
          lineHeight: `${bh}px`,
          textAlign: 'center',
          borderRadius: 14 * k,
          background: hex(c.bannerColor),
          color: '#fff',
          font: `900 ${bs}px Inter, system-ui, sans-serif`,
          whiteSpace: 'pre',
          opacity: alpha,
          transform: `scale(${sc})`,
        }}
      >
        {c.bannerText}
      </div>,
    );
  }
  return <>{els}</>;
}

// ------------------------------------------------------------ inspector --

function DurField({ label, value, onChange, min = 0, expose }: { label: string; value: number; onChange: (ms: number) => void; min?: number; expose?: string }) {
  const toast = useApp((s) => s.toast);
  const [txt, setTxt] = useState<string | null>(null);
  const commit = () => {
    if (txt == null) return;
    const p = T.parseDur(txt);
    if ('err' in p || p.ms < min) toast(`Refused: ${'err' in p ? p.err : 'value too small'}`, 'error');
    else onChange(p.ms);
    setTxt(null);
  };
  return (
    <Row label={label} expose={expose} exposeValue={value}>
      <input style={{ fontFamily: 'var(--mono, monospace)' }} value={txt ?? T.plainDur(value)} placeholder="mm:ss" onChange={(ev) => setTxt(ev.target.value)} onBlur={commit} onKeyDown={(ev) => (ev.stopPropagation(), ev.key === 'Enter' && commit())} />
    </Row>
  );
}

const sampleText = (layer: L, data: Data, fmt: string) => {
  const e = T.eff({ ...layer, format: fmt }, data);
  const d = T.display(e, undefined, { now: Date.now(), ageMs: 0, fps: 25, defaultTz: '' }, undefined);
  return T.segText(d.segs, e.c.sep);
};

function setPrecision(f: string, p: string) {
  return f.replace(/[.:,]?(SS|S|FF)$/, '') + ({ s: '', t: '.S', h: '.SS', f: ':FF' } as Record<string, string>)[p];
}

function Inspector({ layer, data, edit, set }: { layer: L; data: Data; edit: (fn: (l: L) => void, key?: string) => void; set: (path: string, v: unknown, coalesce?: boolean) => void }) {
  const e = T.eff(layer, data);
  const c = e.c;
  const mode = e.mode;
  const now = useFrame();
  const list = PRESETS[mode];
  const preview = T.hasToken(e.format) ? `${c.prefix ? c.prefix + ' ' : ''}${sampleText(layer, data, e.format)}${c.suffix ? ' ' + c.suffix : ''}` : null;
  const zoneMode = c.tzOffset != null ? 'offset' : layer.timezone?.trim() ? 'named' : 'machine';
  void now;
  return (
    <>
      <Section id="timer-main" title="Timer">
        <Seg
          expose="timerMode"
          exposeValue={mode}
          label="Mode"
          value={mode}
          options={MODES}
          onChange={(v) =>
            edit((l) => {
              const x = l as L & Config;
              x.timerMode = v;
              x.mode = LEGACY_MODE[v] as L['mode'];
              x.format = PRESETS[v][0][0];
              if (PRESETS[v][0][1]) x.case = PRESETS[v][0][1];
              x.zeros = 'pad';
              if (STEPS[v]) x.steps = structuredClone(STEPS[v]);
              if (v !== 'clock') x.cities = false;
            })
          }
        />
        <Note>Changing the mode keeps the style and resets the format. The layer name is how the API, Stream Deck and GPI reach this timer.</Note>
        <Row expose="format" exposeValue={layer.format} label="Preset">
          <select
            value={list.some((p) => p[0] === layer.format) ? layer.format : '__custom'}
            onChange={(ev) => {
              const p = list.find((x) => x[0] === ev.target.value);
              if (!p) return;
              edit((l) => {
                const x = l as L & Config;
                x.format = p[0];
                if (p[1]) x.case = p[1];
                if (mode === 'stopwatch') x.swRound = x.swRound ?? 'trunc';
              });
            }}
          >
            {list.map(([f]) => (
              <option key={f} value={f}>
                {f} → {sampleText(layer, data, f)}
              </option>
            ))}
            <option value="__custom">Custom format…</option>
          </select>
        </Row>
        <Text label="Format" path="format" placeholder="HH:mm:ss" />
        {preview != null ? (
          <Note>
            Preview: <b style={{ fontFamily: 'var(--mono, monospace)' }}>{preview}</b>
          </Note>
        ) : (
          <Msg level="error">No token in the format: add HH, mm, ss…</Msg>
        )}
        <Note>
          Tokens: <b>HH</b> hours · <b>mm</b> minutes · <b>ss</b> seconds · <b>S</b> tenths · <b>SS</b> hundredths · <b>FF</b> frames · <b>DD</b>/<b>D</b> day or days · <b>MMMM</b> <b>MMM</b> month · <b>YYYY</b> year · <b>dddd</b> <b>ddd</b> weekday · <b>A</b> AM/PM. Text in [brackets] is shown as
          is; “:” is the separator. Older tokens (yyyy dd d hh h m s f) still work.
        </Note>
      </Section>

      <Section id="timer-digits" title="Digits">
        <Toggle label="Tabular" path="tabular" value={false} text="Fixed-width digits (every digit the same width)" />
        <Seg
          label="Leading zeros"
          path="zeros"
          value="pad"
          options={[
            ['pad', 'Show · 00:01:05'],
            ['trim', 'Hide · 1:05'],
          ]}
        />
        {T.timed(e) && <Toggle label="Hours" path="hoursAuto" value={false} text="Hours (and days) only when needed" />}
        <Seg
          label="Separator"
          path="sep"
          value=":"
          options={[
            [':', ':'],
            ['h', 'h'],
            ["'", "'"],
            [' ', 'space'],
            ['.', '.'],
          ]}
        />
        <Toggle label="Blink" path="sepBlink" value={false} text="Blinking separator (once a second)" />
      </Section>

      {!T.timed(e) && (
        <Section id="timer-zone" title="Time zone">
          <Seg
            expose="timezone"
            exposeValue={(layer as L & Config).timezone ?? ''}
            exposeOptions={[]}
            label="Zone"
            value={zoneMode}
            options={[
              ['machine', 'Server'],
              ['named', 'Named zone'],
              ['offset', 'Manual offset'],
            ]}
            onChange={(v) =>
              edit((l) => {
                const x = l as L & Config;
                if (v === 'offset') x.tzOffset = x.tzOffset ?? 0;
                else {
                  delete x.tzOffset;
                  x.timezone = v === 'named' ? x.timezone?.trim() || 'Europe/Paris' : '';
                }
              })
            }
          />
          {zoneMode === 'named' && <Select label="Zone name" path="timezone" value="Europe/Paris" options={ZONES.includes(layer.timezone) ? ZONES : [layer.timezone, ...ZONES]} />}
          {zoneMode === 'offset' && <Range label="UTC offset" path="tzOffset" value={0} min={-12} max={14} step={0.25} fmt={(v) => `UTC${v < 0 ? '−' : '+'}${Math.floor(Math.abs(v))}:${String((Math.abs(v) % 1) * 60).padStart(2, '0')}`} />}
          <Note>{mode === 'date' ? 'The date switches at midnight in this zone.' : 'Named zones follow summer / winter time by themselves. “Server” is the zone of the playout server.'}</Note>
        </Section>
      )}
      {mode === 'clock' && (
        <Section id="timer-clock" title="Clock">
          <Seg
            label="Hours"
            path="h12"
            value={false}
            options={[
              [false, '24 h'],
              [true, '12 h'],
            ]}
          />
          {c.h12 && (
            <>
              <Text label="AM text" path="am" value="AM" />
              <Text label="PM text" path="pm" value="PM" />
            </>
          )}
          <Row label="Source">
            <div className="wk-btns">
              <button className="opx-btn small violet" title="The playout server's clock; every client applies its offset to the server">
                System clock
              </button>
              <button className="opx-btn small" disabled title="No timecode input on this product">
                LTC
              </button>
              <button className="opx-btn small" disabled title="No timecode input on this product">
                VITC
              </button>
            </div>
          </Row>
          <Note>The server clock is the reference (clients apply the server offset). LTC / VITC need a timecode input, which this product has not.</Note>
          <Seg
            label="Fine offset in"
            path="fineUnit"
            value="s"
            options={[
              ['s', 'Seconds'],
              ['f', 'Frames'],
            ]}
          />
          {c.fineUnit === 's' ? <Range label="Fine offset" path="fine" value={0} min={-10} max={10} step={0.1} unit=" s" /> : <Range label="Fine offset" path="fine" value={0} min={-50} max={50} step={1} unit=" fr" />}
          <Toggle
            expose="cities"
            exposeValue={c.cities}
            label="Cities"
            value={c.cities}
            text="Several city clocks side by side"
            onChange={(v) =>
              edit((l) => {
                const x = l as L & Config;
                x.cities = v;
                if (v && !x.cityList?.length)
                  x.cityList = [
                    { label: 'Paris', zone: 'Europe/Paris' },
                    { label: 'New York', zone: 'America/New_York' },
                    { label: 'Tokyo', zone: 'Asia/Tokyo' },
                  ];
                if (v) x.format = 'HH:mm';
              })
            }
          />
          {c.cities && (
            <ListEditor
              path="cityList"
              value={[]}
              fields={[
                { key: 'label', placeholder: 'City' },
                { key: 'zone', w: 150, options: [['', 'Server'], ...ZONES.map((z) => [z, z] as [string, string])] },
              ]}
              add={() => ({ label: 'London', zone: 'Europe/London' })}
              addLabel="Add a city"
              min={1}
            />
          )}
        </Section>
      )}
      {mode === 'date' && (
        <Section id="timer-date" title="Date">
          <Select label="Language" path="lang" value="en-GB" options={T.LANGS} />
          <Note>Day and month names use this language, whatever the language of the app.</Note>
          <Seg
            label="Case"
            path="case"
            value="none"
            options={[
              ['none', 'As is'],
              ['first', 'First'],
              ['words', 'Words'],
              ['upper', 'UPPER'],
              ['lower', 'lower'],
            ]}
          />
        </Section>
      )}
      {mode === 'stopwatch' && (
        <Section id="timer-sw" title="Stopwatch">
          <DurField label="Start value" value={c.swStart} onChange={(v) => set('swStart', v)} expose="swStart" />
          <Toggle label="Limit" path="swLimitOn" value={false} text="Stop, continue or restart at a limit" />
          {c.swLimitOn && (
            <>
              <DurField label="Limit at" value={c.swLimit} min={1000} onChange={(v) => set('swLimit', v)} expose="swLimit" />
              <Seg
                label="At the limit"
                path="swLimitMode"
                value="stop"
                options={[
                  ['stop', 'Stop'],
                  ['continue', 'Continue'],
                  ['restart', 'Restart'],
                ]}
              />
            </>
          )}
          <Seg
            expose="format"
            exposeValue={e.format}
            exposeOptions={[]}
            label="Precision"
            value={/FF$/.test(e.format) ? 'f' : /SS$/.test(e.format) ? 'h' : /S$/.test(e.format) ? 't' : 's'}
            options={[
              ['s', 'Seconds'],
              ['t', 'Tenths'],
              ['h', 'Hundredths'],
              ['f', 'Frames'],
            ]}
            onChange={(v) => set('format', setPrecision(e.format, v))}
          />
          <Seg
            label="Rounding"
            path="swRound"
            value="trunc"
            options={[
              ['trunc', 'Truncate'],
              ['near', 'Nearest'],
            ]}
          />
          <Range label="Split hold" path="splitHold" value={5} min={1} max={15} unit=" s" />
          <Note>Split freezes the display for this time; the stopwatch keeps running behind.</Note>
        </Section>
      )}
      {mode === 'countdown' && (
        <Section id="timer-cd" title="Countdown">
          <Seg
            label="Target"
            path="cdTarget"
            value="duration"
            options={[
              ['duration', 'A duration'],
              ['time', 'A time'],
            ]}
          />
          {c.cdTarget === 'duration' ? (
            <DurField label="Duration" value={c.cdDuration} min={1000} onChange={(v) => set('cdDuration', v)} expose="cdDuration" />
          ) : (
            <>
              <Text label="Date" path="tDate" value="" placeholder="today (YYYY-MM-DD)" />
              <Text label="Time" path="tTime" value="20:00:00" placeholder="20:00:00" />
              <Select label="Zone" path="tZone" value="" options={[['', 'Server'] as [string, string], ...ZONES.map((z) => [z, z] as [string, string])]} />
              <Note>A target time is absolute: it does not move with summer / winter time.</Note>
            </>
          )}
          <Toggle label="Round up" path="roundUp" value={true} text="Round up (shows 5:00 at start, 0:00 only at zero)" />
          <Seg
            label="At zero"
            path="atZero"
            value="freeze"
            options={[
              ['freeze', 'Freeze'],
              ['overrun', 'Overrun +'],
              ['restart', 'Restart'],
              ['out', 'Hide'],
            ]}
          />
          {c.atZero === 'overrun' && (
            <>
              <ColorPick label="Overrun text" path="overColor" value="#ff3b5c" />
              <Text label="Overrun bg" path="overBg" value="" placeholder="none (plate colour)" />
            </>
          )}
          {c.atZero === 'restart' && c.cdTarget === 'time' && <Msg level="info">Restart needs a duration: a countdown to a time freezes at zero.</Msg>}
          <Toggle label="Banner" path="banner" value={false} text="Show a banner at zero (4 s)" />
          {c.banner && (
            <>
              <Content label="Banner text" path="bannerText" value="" />
              <ColorPick label="Banner colour" path="bannerColor" value="#ff3b5c" />
            </>
          )}
        </Section>
      )}
      {T.timed(e) && (
        <>
          <Section id="timer-start" title="Start">
            <Seg
              label="Start"
              path="startMode"
              value="manual"
              options={[
                ['manual', 'Manual'],
                ['auto', 'At In'],
                ['at', 'At a time'],
                ['ext', 'External'],
              ]}
            />
            {c.startMode === 'at' && <Text label="Start at" path="startAt" value="20:00:00" placeholder="20:00:00 (server zone)" />}
            {c.startMode === 'ext' && <Note>Started by the API (Stream Deck, GPI box): POST /api/channels/&#123;id&#125;/command &#123;action:'act', target:'{layer.name}', op:'start'&#125;.</Note>}
            {T.isTarget(e) && <Note>A countdown to a time always runs; the start mode applies to durations and the stopwatch.</Note>}
            <Toggle label="Off air" path="offAir" value={true} text="Time runs off air (at the In it shows its real value)" />
          </Section>
          <Section id="timer-steps" title="Style steps">
            <Note>{mode === 'countdown' ? 'Under X seconds left, apply this text colour, background and blink (the smallest matching step wins).' : 'From X seconds elapsed, apply this text colour, background and blink.'}</Note>
            <ListEditor
              path="steps"
              value={[]}
              toggle="on"
              fields={[
                { key: 'at', num: true, w: 56, placeholder: 's' },
                { key: 'color', color: true, w: 36 },
                { key: 'bg', placeholder: 'bg #hex' },
                {
                  key: 'blink',
                  w: 76,
                  options: [
                    ['', 'Steady'],
                    ['true', 'Blink'],
                  ],
                },
              ]}
              add={() => ({ on: true, at: 30, color: '#facc15', bg: '', blink: false })}
              addLabel="Add a step"
            />
          </Section>
        </>
      )}
      <Section id="timer-width" title="Width">
        <Toggle label="Reserve" path="reserve" value={false} text="Size on the widest value of the format" />
        <Toggle label="Guide" path="guide" value={true} text="Show the reserved width (faint, Designer only)" />
        <Toggle label="Fit" path="fit" value={false} text="Shrink to fit the box width" />
        <Note>{c.reserve ? 'The value keeps the width of its widest form (e.g. 88:88): 9:59 → 10:00 moves nothing.' : 'Off: the text box follows the value, so 9:59 → 10:00 moves the plate.'}</Note>
      </Section>
      <Section id="timer-style" title="Text style">
        <FontControls layer={layer as Layer & FontStyle} set={(k, v) => set(k, v)} />
        <GroupRow layer={layer} spec={{ label: 'Size', props: ['fontSize'], min: 1, suffix: 'px' }} />
        <ColorGroupRow layer={layer} prop="fill" label="Colour" />
        <Toggle label="Plate" path="plate.on" value={false} text="Background plate" />
        {c.plate.on && (
          <>
            <ColorPick label="Plate colour" path="plate.color" value={T.DEF.plate.color} />
            <Range label="Radius" path="plate.radius" value={22} min={0} max={80} unit=" px" />
            <Range label="Padding" path="plate.padX" value={46} min={0} max={120} unit=" px" />
            <Range label="Padding V" path="plate.padY" value={14} min={0} max={80} unit=" px" />
            <Toggle label="Accent" path="plate.accent" value={true} text="Accent bar on the left" />
            {c.plate.accent && <ColorPick label="Accent colour" path="plate.accentColor" value="#ff3b5c" />}
            <Toggle label="Shadow" path="plate.shadow" value={true} text="Drop shadow" />
          </>
        )}
      </Section>
      <Section id="timer-affix" title="Prefix / suffix" closed={!c.prefix && !c.suffix}>
        <Content label="Prefix" path="prefix" value="" placeholder="J-, Live in…" />
        <Content label="Suffix" path="suffix" value="" placeholder="min" />
        <Range label="Size" path="affix.size" value={30} min={15} max={100} unit=" %" />
        <ColorPick label="Colour" path="affix.color" value="#a594ff" />
        <Seg
          label="Weight"
          path="affix.weight"
          value={800}
          options={[
            [500, 'Medium'],
            [700, 'Bold'],
            [800, 'Extra'],
            [900, 'Black'],
          ]}
        />
        <Toggle label="Capitals" path="affix.upper" value={true} text="Uppercase" />
      </Section>
    </>
  );
}

// ------------------------------------------------------------- operator --

const LIGHT = { ok: '#22c55e', warn: '#f59e0b', err: '#ff3b5c', idle: '#6b7290' };
const chip = (txt: string, c: string) => <span style={{ font: '800 10.5px Inter, system-ui, sans-serif', letterSpacing: '.08em', padding: '3px 8px', borderRadius: 10, background: `${c}26`, color: c, border: `1px solid ${c}66` }}>{txt}</span>;

function statusOf(e: T.Eff, r: T.Run, now: number, tz: string): [string, string] {
  const val = T.value(e, r, now, tz);
  const raw = T.rawValue(e, r, now, tz);
  if (!T.started(e, r) || (e.legacy && e.manualStart && r.startedAt === now)) return e.start === 'manual' || e.legacy ? ['READY', '#6b7290'] : ['ARMED', '#38bdf8'];
  if (r.pausedAt != null) {
    if (val?.limit) return ['LIMIT', '#facc15'];
    if (e.mode === 'countdown' && raw != null && raw <= 0) return ['ZERO', '#ff3b5c'];
    return ['PAUSED', '#f59e0b'];
  }
  if (val?.limit) return ['LIMIT', '#facc15'];
  if (val?.over) return ['OVERRUN', '#ff3b5c'];
  if (e.mode === 'countdown' && raw != null && raw <= 0) return [e.atZero === 'restart' && !e.cdTime ? 'LOOPING' : 'ZERO', '#ff3b5c'];
  return ['RUNNING', '#22c55e'];
}

const fmtClock = (ms: number, tz: string) => {
  const c = T.compAt(ms, T.zoneNamed(''), tz);
  return `${String(c.h).padStart(2, '0')}:${String(c.mi).padStart(2, '0')}:${String(c.s).padStart(2, '0')}`;
};

function Operator({ layer, state, data, act, item, time }: { layer: L; state: unknown; data: Data; act: (op: string, args?: unknown) => void; item?: unknown; time: { nowMs: number; ageSecs: number; defaultTz: string } }) {
  useFrame();
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const inp = useRef<HTMLInputElement>(null);
  const serverOffset = useApp((s) => s.serverOffset) ?? 0;
  const got = useRef({ age: time.ageSecs, at: Date.now() });
  if (got.current.age !== time.ageSecs) got.current = { age: time.ageSecs, at: Date.now() };
  const now = Date.now() + (item ? serverOffset : 0);
  const e = T.eff(layer, data);
  const st = state as State | undefined;
  const tz = time.defaultTz;
  const fps = 25;
  const onAir = !!item;
  const ageMs = got.current.age * 1000 + (Date.now() - got.current.at);
  const r = T.run(e, st, now, ageMs, tz);
  const tgt = T.isTarget(e);
  const isTimed = T.timed(e);
  const paused = r.pausedAt != null;
  const st0 = T.started(e, r);
  const confirmReset = async () => {
    if (onAir && !(await confirmDialog({ title: `${layer.name} is on air: reset it to its start value?`, confirm: 'Reset' }))) return;
    act('reset');
  };
  const set = () => {
    const p = tgt ? T.parseTarget(input) : T.parseDur(input);
    if ('err' in p) return setErr(p.err);
    if (!tgt && e.mode === 'stopwatch' && e.c.swLimitOn && 'ms' in p && p.ms > e.c.swLimit) return setErr(`${T.plainDur(p.ms)} is above the limit ${T.plainDur(e.c.swLimit)}`);
    act('set', { value: input.trim() });
    setErr('');
    setInput('');
  };
  const adj = (s: number) => act('adjust', { seconds: s });
  useKeys(
    isTimed
      ? {
          ' ': () => act('toggle'),
          s: () => act('start'),
          p: () => act(paused ? 'resume' : 'pause'),
          x: () => void confirmReset(),
          t: () => act('restart'),
          l: () => e.mode === 'stopwatch' && act('split'),
          '1': () => adj(-10),
          '2': () => adj(-1),
          '3': () => adj(1),
          '4': () => adj(10),
          '5': () => adj(60),
          v: () => setTimeout(() => inp.current?.focus(), 30),
        }
      : {},
  );
  const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--line-2, var(--line))' };
  const big: CSSProperties = { font: '800 46px/1.05 var(--mono, monospace)', letterSpacing: '.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const api = (op: string) => `API: POST /api/channels/{id}/command {action:'act', target:'${layer.name}', op:'${op}'}`;
  const [prefix, suffix] = T.affixes(e.c, data);
  if (!isTimed) {
    const txt =
      e.c.cities && e.c.cityList.length ? e.c.cityList.map((ct) => `${ct.label || ct.zone || 'Server'} ${T.segText(T.display(e, st, { now, ageMs, fps, defaultTz: tz }, T.zoneNamed(ct.zone)).segs, e.c.sep)}`).join(' · ') : T.segText(T.display(e, st, { now, ageMs, fps, defaultTz: tz }).segs, e.c.sep);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={box}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontWeight: 600, fontSize: 12 }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', flex: 'none', background: LIGHT.ok, boxShadow: `0 0 0 4px ${LIGHT.ok}33, 0 0 10px ${LIGHT.ok}` }} />
            <span>Server clock · synced (offset applied){e.c.fine ? ` · fine offset ${e.c.fine > 0 ? '+' : ''}${e.c.fine} ${e.c.fineUnit === 'f' ? 'fr' : 's'}` : ''}</span>
          </div>
          <div style={{ ...big, fontSize: 30 }}>{txt}</div>
        </div>
        <Note>{e.mode === 'clock' ? 'The clock' : 'The date'} runs by itself: no transport control, only the time source status.</Note>
      </div>
    );
  }
  const d = T.display(e, st, { now, ageMs, fps, defaultTz: tz });
  const [stTxt, stCol] = statusOf(e, r, now, tz);
  const lines: string[] = [];
  if (d.split) {
    const v = T.value(e, r, now, tz);
    if (v) lines.push(`Split frozen on air · running behind: ${T.segText(T.dur(e, v.v, fps, e.c.swRound === 'near' ? 'near' : 'trunc'), e.c.sep)}`);
  }
  if (r.startedAt != null && !tgt) lines.push(`Started ${fmtClock(r.startedAt, tz)} · pauses ${T.plainDur(Math.round(r.pausedTotal / 100) * 100)}${r.adj ? ` · adjusted ${r.adj > 0 ? '+' : '−'}${T.plainDur(Math.abs(r.adj))}` : ''} · server time − start − pauses: no drift`);
  if (tgt) {
    const t = T.targetOf(e, r, now, tz);
    if (t != null) lines.push(`Target ${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} UTC (absolute)`);
  }
  if (e.legacy) lines.push('Older timer layer: follows its time on air.');
  const color = d.color ? hex(d.color) : 'var(--text)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {chip(stTxt, stCol)}
          {onAir ? chip('ON AIR', '#ff3b5c') : chip('TRY-OUT', '#a3a9bd')}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>{MODES.find((m) => m[0] === e.mode)![1]}</span>
        </div>
        <div style={{ ...big, color, opacity: d.hidden ? 0.4 : 1 }}>{`${prefix ? prefix + ' ' : ''}${T.segText(d.segs, e.c.sep)}${suffix ? ' ' + suffix : ''}`}</div>
        {lines.length > 0 && (
          <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-3)' }}>
            {lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
      <Btns
        list={[
          { label: '▶ Start', cls: 'green big', keyHint: 'S', disabled: st0 && !paused, title: tgt ? 'A countdown to a time always runs' : undefined, onClick: () => act('start') },
          { label: paused ? '⏯ Resume' : '⏸ Pause', cls: 'amber big', keyHint: 'P', disabled: !st0, onClick: () => act(paused ? 'resume' : 'pause') },
          { label: '↺ Reset', cls: 'big', keyHint: 'X', confirm: onAir ? `${layer.name} is on air: reset it to its start value?` : undefined, onClick: () => act('reset') },
          { label: '⟲ Restart', cls: 'violet big', keyHint: 'T', onClick: () => act('restart') },
          e.mode === 'stopwatch' && { label: '⏱ Split', cls: 'big', keyHint: 'L', disabled: !st0 || paused, onClick: () => act('split') },
        ]}
      />
      <Btns
        label="Adjust"
        list={(
          [
            ['−10 s', -10, '1'],
            ['−1 s', -1, '2'],
            ['+1 s', 1, '3'],
            ['+10 s', 10, '4'],
            ['+1 min', 60, '5'],
          ] as [string, number, string][]
        ).map(([label, s, k]) => ({ label, keyHint: k, cls: 'ghost', onClick: () => adj(s) }))}
      />
      <Row label={tgt ? 'New target' : 'Set value'}>
        <div style={{ display: 'flex', gap: 6, width: '100%' }}>
          <input
            ref={inp}
            style={{ flex: 1, minWidth: 0, fontFamily: 'var(--mono, monospace)' }}
            value={input}
            placeholder={tgt ? '20:00:00 or 2026-10-18 20:00' : 'mm:ss or h:mm:ss'}
            onChange={(ev) => setInput(ev.target.value)}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === 'Enter') set();
            }}
          />
          <button className="opx-btn violet" onClick={set}>
            Set <kbd>V</kbd>
          </button>
        </div>
      </Row>
      {err && <Msg level="error">⛔ {err} — nothing changed on air.</Msg>}
      {e.start === 'ext' && !tgt && !st0 && <Msg level="info">Waiting for the external trigger (API, Stream Deck, GPI box).</Msg>}
      <Note>
        <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: 10.5 }}>
          {api('start')} · ops: start, pause, resume, toggle, reset, restart, adjust {'{seconds:10}'}, set {"{value:'05:00'}"}
          {e.mode === 'stopwatch' ? ', split' : ''}
        </span>
        <br />
        Keys: Space start / pause · S P X T{e.mode === 'stopwatch' ? ' L' : ''} · 1–5 adjust · V set value
      </Note>
    </div>
  );
}

// ------------------------------------------------------------- warnings --

function warnings(layer: L, data: Data, state: unknown): Warning[] {
  const out: Warning[] = [];
  const e = T.eff(layer, data);
  const now = Date.now();
  const tz = useApp.getState().timezone ?? '';
  if (!T.hasToken(e.format)) out.push({ level: 'error', text: 'The format has no time token: nothing would move on screen.' });
  if (!T.timed(e)) {
    if ('name' in e.zone && e.zone.name && !T.validZone(e.zone.name)) out.push({ level: 'error', text: `Unknown time zone “${e.zone.name}”: the server zone is used.` });
    if (e.c.cities) for (const ct of e.c.cityList) if (ct.zone && !T.validZone(ct.zone)) out.push({ level: 'error', text: `Unknown time zone “${ct.zone}” (${ct.label}).` });
    return out;
  }
  const st = state as State | undefined;
  const r = T.run(e, st, now, 0, tz);
  if (T.isTarget(e)) {
    const t = T.targetOf(e, r, now, tz);
    if (t == null) out.push({ level: 'error', op: true, text: 'The target time is empty or invalid: the countdown shows --:--.' });
    else if (t <= now && now - t > 3000) {
      const z = { freeze: 'frozen at 0', overrun: 'overrun', restart: 'frozen at 0', out: 'widget hidden' }[e.atZero];
      out.push({ level: 'warn', op: true, text: `Target already passed (${T.plainDur(Math.floor((now - t) / 1000) * 1000)} ago): zero behaviour applied — ${z}.` });
    }
  }
  if (!e.c.reserve) out.push({ level: 'info', text: 'Width reservation off: the plate moves when the number of digits changes.' });
  if (!e.legacy && !T.isTarget(e) && !st?.ctl) {
    if (e.start === 'at') {
      const ts = T.startAtMs(e, now, tz);
      out.push(
        ts == null
          ? { level: 'error', op: true, text: 'Start time invalid: use HH:mm:ss.' }
          : { level: 'info', op: true, text: `Starts by itself at ${e.c.startAt}${ts > now ? ` (in ${T.plainDur(Math.ceil((ts - now) / 1000) * 1000)})` : now - ts < 6 * 3600000 ? ' — started' : ' — already passed today, start it by hand'}.` },
      );
    }
    if (e.start === 'ext') out.push({ level: 'info', op: true, text: 'Waiting for the external trigger (API).' });
    if (e.start === 'auto') out.push({ level: 'info', op: 'only', text: 'Starts by itself at the In.' });
  }
  if (e.mode === 'stopwatch' && e.c.swLimitOn && e.c.swLimit <= e.c.swStart) out.push({ level: 'warn', text: 'The limit is not above the start value: it is ignored.' });
  return out;
}

const timerDef = () =>
  defineWidget({
    id: 'timer',
    type: 'clock',
    label: 'Timer',
    group: 'Time',
    icon: Timer,
    presets: [
      { label: 'Clock', hint: 'Time of day', patch: {} },
      { label: 'Date', hint: 'Day and month names', patch: { timerMode: 'date', format: 'dddd D MMMM YYYY', case: 'first', plate: { on: false } } },
      { label: 'Stopwatch', hint: 'Start, pause, split', patch: { timerMode: 'stopwatch', mode: 'elapsed', format: 'mm:ss', steps: STEPS.stopwatch } },
      { label: 'Countdown', hint: 'To zero or to a time', patch: { timerMode: 'countdown', mode: 'timer', format: 'mm:ss', steps: STEPS.countdown } },
      {
        label: 'City clocks',
        hint: 'Several zones side by side',
        patch: {
          cities: true,
          format: 'HH:mm',
          cityList: [
            { label: 'Paris', zone: 'Europe/Paris' },
            { label: 'New York', zone: 'America/New_York' },
            { label: 'Tokyo', zone: 'Asia/Tokyo' },
          ],
          props: { width: 1600, height: 300, fontSize: 120, fill: [1, 1, 1, 1] },
        },
      },
    ],
    create: () => ({
      mode: 'time' as const,
      format: 'HH:mm:ss',
      timezone: '',
      target: '',
      fontFamily: 'Inter',
      fontWeight: 800,
      align: 'center' as const,
      verticalAlign: 'middle' as const,
      uppercase: false,
      timerMode: 'clock' as const,
      tabular: true,
      reserve: true,
      fit: true,
      hoursAuto: true,
      lang: 'fr-FR',
      plate: { on: true },
      props: { width: 900, height: 300, fontSize: 150, fill: [1, 1, 1, 1] },
    }),
    live: () => true,
    content: ['prefix', 'suffix', 'bannerText'],
    Render: (p) => <TimerView layer={p.layer as L} r={p.r} w={p.w} h={p.h} data={p.data} time={p.time} state={p.state} fps={p.fps} designer={p.designer} />,
    Inspector: (p) => <Inspector layer={p.layer as L} data={p.data} edit={p.edit as never} set={p.set} />,
    Operator: (p) => <Operator layer={p.layer as L} state={p.state} data={p.data} act={p.act} item={p.item} time={p.time} />,
    warnings: (l, { data, state }) => warnings(l as L, data, state),
  });

export default timerDef();
