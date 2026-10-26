// Text: settings, drawing and inspector (no Operator controls: the Operator's
// fit warnings come from engine/Scene.tsx textWarnings).
// Same picture as crates/cg-render/src/wid/text.rs; fit chain in engine/textFit.ts
// (fitLines, mirror of text::fit_lines); language rules in crates/cg-core/src/wid/text.rs.
import { FontPick } from '../ui/FontPick';
import { useContext, type CSSProperties } from 'react';
import { align, RichKeys, runs as richRuns, type Run } from '../engine/rich';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, Italic, Strikethrough, Type, Underline } from 'lucide-react';
import { Segmented } from '../ui/fields';
import { col, cssColor, interpolateText, num, propValue, transformText, type Resolved } from '../engine/evaluate';
import type { Data, Layer, Template, TextOverflow } from '../engine/types';
import { useFonts } from '../engine/fonts';
import { useApp } from '../store';
import { fitLines, graphemes, HYPHEN_LANGS, type FitLines } from '../engine/textFit';
import { frameSpeed, scrollPositions } from '../engine/widgets';
import { ColorGroupRow, GroupRow } from '../designer/Inspector';
import { ColorPick, Content, defineWidget, hex, Num, Row, Section, Seg, Select, Toggle, wiredKeys, type LayerOf, type Warning, withDefaults } from './kit';
import { t, tc } from '../i18n';
import { ON_AIR, SocialSource } from './socialSource';

/** Settings of the layer (flattened into it; every field optional: older projects lack them). */
export interface Config {
  /** Paragraph: most lines (0 = as many as fit). */
  maxLines?: number;
  breakMode?: 'word' | 'hyphen';
  lang?: string;
  /** What Fit does at its minimums. */
  fitEnd?: 'clip' | 'ellipsis';
  italic?: boolean;
  fillType?: 'solid' | 'gradient';
  color2?: string;
  gradAngle?: number;
  strokeOutside?: boolean;
  shadow?: boolean;
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  band?: boolean;
  bandColor?: string;
  bandPadX?: number;
  bandGap?: number;
  bandRadius?: number;
  bandAccent?: boolean;
  bandAccentColor?: string;
  justify?: boolean;
  dir?: 'ltr' | 'rtl';
  /** Most characters the Operator can type in its field (0 = no limit). */
  maxChars?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface State {}

export const D: Required<Config> = {
  maxLines: 0,
  breakMode: 'word',
  lang: '',
  fitEnd: 'clip',
  italic: false,
  fillType: 'solid',
  color2: '#a594ff',
  gradAngle: 90,
  strokeOutside: false,
  shadow: false,
  shadowColor: '#000000aa',
  shadowX: 0,
  shadowY: 4,
  shadowBlur: 12,
  band: false,
  bandColor: '#24164f',
  bandPadX: 26,
  bandGap: 10,
  bandRadius: 0,
  bandAccent: true,
  bandAccentColor: '#ff3b5c',
  justify: false,
  dir: 'ltr',
  maxChars: 0,
};
const cfg = (c: Config): Required<Config> => withDefaults(D, c);

type TextLayer = LayerOf<'text'>;

// ------------------------------------------------------------ measuring --

/** Colour emoji and symbol fonts after the text's (never an empty box: the browser falls back per character). */
export const EMOJI_STACK = `"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "DejaVu Sans", "FreeSerif"`;
/** CSS font-family of a family, with the same fallbacks as the Rust renderer. */
export const fontStack = (family: string) => `"${family}", Inter, ${EMOJI_STACK}, system-ui, sans-serif`;
/** CSS `font` shorthand. */
export const fontCss = (family: string, weight: number, size: number, italic = false) => `${italic ? 'italic ' : ''}${weight} ${size}px ${fontStack(family)}`;

let mctx: CanvasRenderingContext2D | null = null;
const mcache = new Map<string, number>();
let mgen = -1;
/** Width of one line (letter spacing between characters, as text_width / glyph_run). */
export function measure(font: string, ls: number, s: string): number {
  const gen = useFonts.getState().ready;
  if (gen !== mgen || mcache.size > 8000) {
    mcache.clear();
    mgen = gen;
  }
  const key = `${font}|${ls}|${s}`;
  let w = mcache.get(key);
  if (w === undefined) {
    mctx ??= document.createElement('canvas').getContext('2d');
    if (!mctx) return s.length * 10;
    mctx.font = font;
    const chars = [...s].filter((c) => !/[​-‍⁠﻿︀-️]/.test(c)).length;
    w = mctx.measureText(s).width + Math.max(0, chars - 1) * ls;
    mcache.set(key, w);
  }
  return w;
}

const caseOf = (l: TextLayer) => (t: string) => (l.uppercase ? t.toUpperCase() : transformText(t, l.transform));
/** Its styled parts as shown (<b>…), null when it has one style. */
export const textRuns = (l: TextLayer, data: Data, rich: (key: string) => boolean = () => false) => richRuns(l.text, data, rich, caseOf(l));
/** The text as shown (fields filled in, case changed, without style tags), as ResolvedLayer::text. */
export const shownText = (l: TextLayer, data: Data, rich?: (key: string) => boolean) => {
  const rs = textRuns(l, data, rich);
  return rs ? rs.map((r) => r.text).join('') : caseOf(l)(interpolateText(l.text, data));
};
/** The weight of the bold parts. */
export const boldOf = (w: number) => Math.min(900, Math.max(400, w) + 300);

export interface TextLayout {
  fit: FitLines;
  font: string;
  ls: number;
  pad: number;
  avail: number;
  text: string;
  runs: Run[] | null;
  /** Weight the lines were measured with. */
  mw: number;
}

/** The fit of the layer with these values (same as the Rust renderer). */
export function layoutText(l: TextLayer, r: Resolved, data: Data, lang?: string, rich?: (key: string) => boolean): TextLayout {
  const k = cfg(l);
  let runs = k.dir === 'rtl' ? null : textRuns(l, data, rich);
  let text = runs ? runs.map((x) => x.text).join('') : shownText(l, data, rich);
  // A ticker: the lines one after the other, with the separator (mirror of wid/text.rs).
  const scroll = l.scroll && l.scroll !== 'none' ? l.scroll : null;
  const sep = l.separator ?? '   •   ';
  if (scroll === 'horizontal') {
    text = text.split('\n').join(sep) + sep;
    runs = runs ? runs.map((x, i, a) => ({ ...x, text: x.text.split('\n').join(sep) + (i === a.length - 1 ? sep : '') })) : null;
  }
  // With bold parts, measured in bold: the lines never get wider than the box.
  const mw = runs?.some((x) => x.style.bold) ? boldOf(l.fontWeight) : l.fontWeight;
  const size0 = num(r.fontSize);
  const ls = num(r.letterSpacing);
  const pad = k.band ? Math.max(0, k.bandPadX) : 0;
  const w = num(r.width);
  const avail = k.band ? Math.max(20, w - 2 * pad) : w;
  const fam = l.fontFamily;
  const fit: FitLines =
    scroll === 'horizontal'
      ? { lines: [{ text, end: true }], size: size0, squeeze: 1, clip: true, ratio: 1, overflows: false, stage: 'fit', forced: false, hyphenated: false }
      : fitLines(
    text,
    {
      size: size0,
      lineHeight: l.lineHeight ?? 1.2,
      boxW: avail,
      // A roll: every line at its size, however long it is.
      boxH: scroll ? 1e9 : num(r.height),
      wrap: !!l.wrap,
      overflow: scroll ? 'visible' : (l.overflow ?? 'fit'),
      squeeze: l.squeeze ?? 0.8,
      minSize: l.minSize ?? 0.6,
      maxLines: k.maxLines,
      hyphen: k.breakMode === 'hyphen',
      lang: k.lang || lang || useApp.getState().project?.language || 'fr',
      ellipsisEnd: k.fitEnd === 'ellipsis',
    },
    (s, size) => measure(fontCss(fam, mw, size, k.italic), ls, s),
  );
  if (scroll) fit.clip = true;
  return { fit, font: fontCss(fam, l.fontWeight, fit.size, k.italic), ls, pad, avail, text, runs, mw };
}

/** The fit badge of the Designer (as the other texts have it). */
const fitBadge = (l: TextLayer, f: FitLines) => (f.overflows ? (l.overflow === 'visible' ? 'overflows' : 'too long') : f.ratio < (l.warnBelow ?? 0.8) ? `${Math.round(f.ratio * 100)} %` : undefined);

// --------------------------------------------------------------- render --

function Render({ layer, r, w, h, data, designer, lang, ageSecs = 0, fps }: { layer: TextLayer; r: Resolved; w: number; h: number; data: Data; designer?: boolean; lang?: string; ageSecs?: number; fps?: number }) {
  const k = cfg(layer);
  const rich = useContext(RichKeys);
  const text = shownText(layer, data, rich);
  if (!text.trim())
    return designer ? (
      <>
        <div style={{ position: 'absolute', inset: 0, border: '4px dashed rgba(255,255,255,.35)', borderRadius: 6, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', left: 14, top: 10, font: '600 22px Inter, sans-serif', color: 'rgba(255,255,255,.45)', whiteSpace: 'nowrap' }}>{t('Empty text · nothing on air')}</div>
      </>
    ) : null;
  const L = layoutText(layer, r, data, lang, rich);
  const parts = L.runs ? align(L.runs, L.fit.lines.map((x) => x.text)) : null;
  const boldFont = fontCss(layer.fontFamily, boldOf(layer.fontWeight), L.fit.size, k.italic);
  const { fit, pad, avail, ls } = L;
  const size = fit.size;
  const sx = fit.squeeze;
  const lh = layer.lineHeight ?? 1.2;
  const lineH = size * lh;
  const n = fit.lines.length;
  const top = layer.verticalAlign === 'top' ? 0 : layer.verticalAlign === 'bottom' ? h - lineH * n : (h - lineH * n) / 2;
  const bw = avail / sx;
  const rtl = k.dir === 'rtl';
  const fill = cssColor(col(r.fill));
  const grad = k.fillType === 'gradient';
  const sw = num(r.strokeWidth);
  const stroke = cssColor(col(r.stroke));
  const shadowCss = k.shadow ? `${k.shadowX}px ${k.shadowY}px ${k.shadowBlur}px ${hex(k.shadowColor)}` : '';
  const deco = layer.decoration === 'underline' ? 'underline' : layer.decoration === 'lineThrough' ? 'line-through' : undefined;
  const bands: CSSProperties[] = [];
  // Where the text is drawn: once, or each copy of a scroll on its way.
  const travelled = frameSpeed(layer.speed ?? 120, fps) * Math.max(0, ageSecs);
  const scroll = layer.scroll && layer.scroll !== 'none' ? layer.scroll : null;
  const placements: [number, number][] =
    scroll === 'horizontal'
      ? scrollPositions(w, measure(fontCss(layer.fontFamily, L.mw, size, k.italic), ls, L.text) + ls, travelled, true).map((x) => [x, 0])
      : scroll === 'vertical'
        ? scrollPositions(h, layer.looping ? lineH * n + h : lineH * n, travelled, !!layer.looping).map((y) => [0, y - top])
        : [[0, 0]];
  const lines = placements.flatMap(([ox, oy], pi) => fit.lines.map((l, i) => {
    const spaces = (l.text.match(/ /g) ?? []).length;
    const segs = parts?.[i];
    const lw0 = segs ? segs.reduce((a, [t, ri]) => a + measure(L.runs![ri].style.bold ? boldFont : L.font, ls, t), 0) : measure(L.font, ls, l.text);
    const justified = k.justify && !l.end && spaces > 0 && lw0 < bw;
    const lw = justified ? bw : lw0;
    const eff = k.justify && !justified ? (rtl ? 'right' : 'left') : layer.align;
    const x = scroll === 'horizontal' ? ox : justified ? 0 : eff === 'center' ? (bw - lw) / 2 : eff === 'right' ? bw - lw : 0;
    const y = top + oy + i * lineH;
    const left = pad + x * sx;
    if (k.band && l.text.trim())
      bands.push({
        position: 'absolute',
        left: left - pad,
        top: y + k.bandGap / 2,
        width: lw * sx + 2 * pad,
        height: Math.max(4, lineH - k.bandGap),
        background: hex(k.bandColor),
        borderRadius: Math.min(k.bandRadius, (lw * sx + 2 * pad) / 2, Math.max(4, lineH - k.bandGap) / 2),
        boxShadow: k.bandAccent ? `inset ${rtl ? -8 : 8}px 0 ${hex(k.bandAccentColor)}` : undefined,
      });
    const st: CSSProperties = {
      position: 'absolute',
      left,
      top: y,
      width: lw + 1,
      height: lineH,
      lineHeight: `${lineH}px`,
      whiteSpace: justified ? 'nowrap' : 'pre',
      textAlign: justified ? 'justify' : rtl ? 'right' : 'left',
      textAlignLast: justified ? 'justify' : undefined,
      transform: sx !== 1 ? `scaleX(${sx})` : undefined,
      transformOrigin: '0 0',
      direction: rtl ? 'rtl' : 'ltr',
      unicodeBidi: 'plaintext',
      font: L.font,
      letterSpacing: ls,
      fontKerning: 'normal',
      textDecoration: deco,
      textDecorationThickness: deco ? `${Math.max(1, size * 0.06)}px` : undefined,
      textUnderlineOffset: deco === 'underline' ? `${size * 0.1}px` : undefined,
      textDecorationSkipInk: 'none',
      color: fill,
    };
    if (grad) {
      Object.assign(st, {
        backgroundImage: `linear-gradient(${k.gradAngle}deg, ${fill}, ${cssColor(col(r.fill2))})`,
        backgroundSize: `${w / sx}px ${h}px`,
        backgroundPosition: `${-left / sx}px ${-y}px`,
        backgroundRepeat: 'no-repeat',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        textDecorationColor: fill,
      });
    }
    // Stroke as its own copy of the line: outside = twice as wide behind the fill, else centred on top (as before).
    const strokeSt: CSSProperties = { ...st, backgroundImage: undefined, color: 'transparent', textDecorationColor: stroke, WebkitTextStroke: `${k.strokeOutside ? sw * 2 : sw}px ${stroke}`, filter: undefined };
    // Styled parts: one span each (colours only on the fill, not on the stroke copies).
    const body = (colours: boolean) =>
      segs
        ? segs.map(([t, ri], j) => {
            const rs = L.runs![ri].style;
            const d = [deco, rs.underline && 'underline', rs.strike && 'line-through'].filter(Boolean).join(' ') || undefined;
            return (
              <span
                key={j}
                style={{
                  fontWeight: rs.bold ? boldOf(layer.fontWeight) : undefined,
                  fontStyle: rs.italic ? 'italic' : undefined,
                  textDecoration: d,
                  textDecorationThickness: d ? `${Math.max(1, size * 0.06)}px` : undefined,
                  textUnderlineOffset: d?.includes('underline') ? `${size * 0.1}px` : undefined,
                  ...(colours && rs.color ? { color: hex(rs.color), WebkitTextFillColor: hex(rs.color), textDecorationColor: hex(rs.color) } : {}),
                }}
              >
                {t}
              </span>
            );
          })
        : l.text || ' ';
    return (
      <div key={`${pi}-${i}`}>
        {sw > 0 && k.strokeOutside && <div style={{ ...strokeSt, WebkitTextStroke: `${sw * 2}px ${stroke}`, color: stroke, WebkitTextFillColor: stroke } as CSSProperties}>{body(false)}</div>}
        <div style={st}>{body(true)}</div>
        {sw > 0 && !k.strokeOutside && <div style={strokeSt}>{body(false)}</div>}
      </div>
    );
  }));
  const badge = designer ? fitBadge(layer, fit) : undefined;
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, overflow: fit.clip ? 'hidden' : 'visible', fontStyle: k.italic ? 'italic' : undefined }}>
        {bands.map((b, i) => (
          <div key={`b${i}`} style={b} />
        ))}
        <div style={{ position: 'absolute', inset: 0, filter: shadowCss ? `drop-shadow(${shadowCss})` : undefined }}>{lines}</div>
      </div>
      {badge && <div data-fit={badge} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />}
    </>
  );
}

// ------------------------------------------------------------ inspector --

const OVERFLOWS: [TextOverflow, string, string][] = [
  ['fit', 'Fit', 'Narrower, then smaller, down to the minimums below; then cut (or “…”)'],
  ['ellipsis', '…', 'Shortened with “…”'],
  ['clip', 'Cut', 'Cut at the box'],
  ['visible', 'Overflow', 'Drawn outside its box'],
];

/** Most characters the Operator can type in a field: the smallest « Max characters » of the Texts showing it (0 = no limit). */
export function maxChars(tpl: Template, key: string): number {
  let out = 0;
  for (const l of tpl.layers) {
    if (l.type !== 'text' || !(l.maxChars! > 0) || !wiredKeys(l.text).includes(key)) continue;
    out = out ? Math.min(out, l.maxChars!) : l.maxChars!;
  }
  return out;
}

function Inspector({ layer, template, edit }: { layer: TextLayer; data: Data; template: Template; edit: (fn: (l: TextLayer) => void, key?: string) => void }) {
  const k = cfg(layer);
  const set = (key: string, v: unknown) => edit((l) => void ((l as unknown as Record<string, unknown>)[key] = v));
  const mode = layer.overflow ?? 'fit';
  const stroke = num(propValue(layer as Layer, 'strokeWidth', 0)) > 0;
  // The Operator types in it (a field of its own, not read from data).
  const typed = wiredKeys(layer.text).some((key) => template.fields.some((f) => f.key === key && !f.binding?.source));
  const scroll = !!layer.scroll && layer.scroll !== 'none';
  return (
    <>
      <SocialSource label={t('Text')} picks={[ON_AIR.name('text'), ON_AIR.text('text'), ON_AIR.city('text'), ON_AIR.platformName('text'), ON_AIR.time('text'), ON_AIR.count('text'), ON_AIR.tag('text'), ON_AIR.tagCount('text'), ON_AIR.tagPerMin('text')]} />
      <Section id="text-content" title={t('Content')}>
        <Content path="text" rich value="" multiline lorem expose placeholder={t('Text')} />
        {typed && <Num label={t('Max characters')} path="maxChars" value={k.maxChars} min={0} max={9999} expose={false} />}
      </Section>
      <Section id="text-font" title={t('Typography')}>
        <FontRow layer={layer} set={set} />
        <GroupRow layer={layer as Layer} spec={{ label: t('Size'), props: ['fontSize'], min: 1, suffix: 'px' }} />
        <Num expose="lineHeight" exposeValue={layer.lineHeight ?? 1.2} label={t('Line height')} value={layer.lineHeight ?? 1.2} min={0.5} max={4} step={0.05} precision={2} unit="×" onChange={(v) => edit((l) => void (l.lineHeight = Math.abs(v - 1.2) < 1e-6 ? undefined : v), `lh-${layer.id}`)} />
        <GroupRow layer={layer as Layer} spec={{ label: tc('text', 'Spacing'), props: ['letterSpacing'], precision: 1, suffix: 'px' }} />
        {/* Italic sits in this row but is not exposed with the alignment. */}
        <Row expose={['align', 'justify']} exposeValue={{ align: layer.align, justify: k.justify }} label={t('Align')}>
          <Segmented
            value={k.justify ? 'justify' : layer.align}
            onChange={(v) =>
              edit((l) => {
                if (v === 'justify') (l as Config).justify = true;
                else {
                  (l as Config).justify = undefined;
                  l.align = v as TextLayer['align'];
                }
              })
            }
            options={[
              { value: 'left', label: <AlignLeft size={13} />, title: t('Left') },
              { value: 'center', label: <AlignCenter size={13} />, title: t('Centre') },
              { value: 'right', label: <AlignRight size={13} />, title: t('Right') },
              { value: 'justify', label: <AlignJustify size={13} />, title: t('Justify (not the last line)') },
            ]}
          />
          <Segmented value={k.italic ? 'i' : ''} onChange={() => set('italic', !k.italic || undefined)} options={[{ value: 'i', label: <Italic size={13} />, title: t('Italic') }]} />
        </Row>
        <Row
          expose="verticalAlign"
          exposeValue={layer.verticalAlign}
          exposeOptions={[
            ['top', t('Top')],
            ['middle', t('Middle')],
            ['bottom', t('Bottom')],
          ]}
          label={t('Vertical')}
        >
          <Segmented
            value={layer.verticalAlign}
            onChange={(v) => set('verticalAlign', v)}
            options={[
              { value: 'top', label: <AlignVerticalJustifyStart size={13} />, title: t('Top') },
              { value: 'middle', label: <AlignVerticalJustifyCenter size={13} />, title: t('Middle') },
              { value: 'bottom', label: <AlignVerticalJustifyEnd size={13} />, title: t('Bottom') },
            ]}
          />
        </Row>
        <Row expose={['transform', 'decoration']} exposeValue={{ transform: layer.transform ?? 'none', decoration: layer.decoration ?? 'none' }} label={t('Case')}>
          <Segmented
            value={layer.uppercase ? 'upper' : (layer.transform ?? 'none')}
            onChange={(v) =>
              edit((l) => {
                l.uppercase = false;
                l.transform = v === 'none' ? undefined : (v as TextLayer['transform']);
              })
            }
            options={[
              { value: 'none', label: '—', title: t('As typed') },
              { value: 'upper', label: 'AA', title: t('UPPER CASE') },
              { value: 'lower', label: 'aa', title: t('lower case') },
              { value: 'capitalize', label: 'Aa', title: t('Each Word') },
            ]}
          />
          <Segmented
            value={layer.decoration ?? 'none'}
            onChange={(v) => set('decoration', v === 'none' ? undefined : v)}
            options={[
              { value: 'none', label: '—', title: t('No decoration') },
              { value: 'underline', label: <Underline size={13} />, title: t('Underline') },
              { value: 'lineThrough', label: <Strikethrough size={13} />, title: t('Strike through') },
            ]}
          />
        </Row>
      </Section>
      <Section id="text-colour" title={t('Colour')}>
        <Seg
          label={t('Fill')}
          path="fillType"
          value={k.fillType}
          options={[
            ['solid', t('Solid')],
            ['gradient', t('Gradient')],
          ]}
        />
        <ColorGroupRow layer={layer as Layer} prop="fill" label={k.fillType === 'gradient' ? t('From') : t('Color')} />
        {k.fillType === 'gradient' && (
          <>
            <ColorGroupRow layer={layer as Layer} prop="fill2" label={t('To')} />
            <Num label={t('Angle')} path="gradAngle" value={k.gradAngle} min={0} max={360} unit="°" />
          </>
        )}
      </Section>
      <Section id="text-effects" title={t('Effects')}>
        <Toggle
          // The width is exposed by its own row (Width): the toggle is not.
          expose={false}
          label={t('Stroke')}
          value={stroke}
          onChange={(v) =>
            edit((l) => {
              l.props.strokeWidth = v ? 2 : 0;
              // A stroke turned on must show: an invisible colour becomes black.
              const sc = col(l.props.stroke ?? [0, 0, 0, 0]);
              if (v && sc[3] === 0) l.props.stroke = [0, 0, 0, 1];
            })
          }
        />
        {stroke && (
          <>
            <ColorGroupRow layer={layer as Layer} prop="stroke" label={t('Color')} />
            <GroupRow layer={layer as Layer} spec={{ label: t('Width'), props: ['strokeWidth'], min: 0, precision: 1, suffix: 'px' }} />
            <Seg
              label={t('Placement')}
              path="strokeOutside"
              value={false}
              options={[
                [false, t('Centred')],
                [true, t('Outside')],
              ]}
            />
          </>
        )}
        <Toggle label={t('Shadow')} path="shadow" value={false} />
        {k.shadow && (
          <>
            <ColorPick label={t('Color')} path="shadowColor" value={D.shadowColor} />
            <Num label={t('Offset X')} path="shadowX" value={k.shadowX} min={-200} max={200} unit="px" />
            <Num label={t('Offset Y')} path="shadowY" value={k.shadowY} min={-200} max={200} unit="px" />
            <Num label={t('Blur')} path="shadowBlur" value={k.shadowBlur} min={0} max={200} unit="px" />
          </>
        )}
        <Toggle label={t('Band')} path="band" value={false} />
        {k.band && (
          <>
            <ColorPick label={t('Color')} path="bandColor" value={D.bandColor} />
            <Num label={t('Padding')} path="bandPadX" value={k.bandPadX} min={0} max={200} unit="px" />
            <Num label={t('Gap')} path="bandGap" value={k.bandGap} min={0} max={200} unit="px" />
            <Num label={t('Corners')} path="bandRadius" value={k.bandRadius} min={0} max={200} unit="px" />
            <Toggle label={t('Accent')} path="bandAccent" value={true} />
            {k.bandAccent && <ColorPick label={t('Accent color')} path="bandAccentColor" value={D.bandAccentColor} />}
          </>
        )}
      </Section>
      {/* A scrolling text is never fitted. */}
      {!scroll && <Section id="text-fit" title={t('When the text is too long')}>
        <Seg
          expose="wrap"
          exposeValue={!!layer.wrap}
          exposeOptions={[
            ['false', t('As typed')],
            ['true', t('Paragraph')],
          ]}
          label={t('Lines')}
          value={layer.wrap ? 'paragraph' : 'single'}
          onChange={(v) => edit((l) => void (l.wrap = v === 'paragraph' || undefined))}
          options={[
            ['single', t('As typed'), t('Line breaks only where you type them')],
            ['paragraph', t('Paragraph'), t('Lines wrap at the width of the box')],
          ]}
        />
        {layer.wrap && (
          <>
            <Num label={t('Max lines')} path="maxLines" value={k.maxLines} min={0} max={99} />
            <Seg
              label={t('Line break')}
              path="breakMode"
              value={k.breakMode}
              options={[
                ['word', t('Whole word')],
                ['hyphen', t('Hyphenation')],
              ]}
            />
            {k.breakMode === 'hyphen' && <Select label={t('Language')} path="lang" value={k.lang} options={[['', t('Project language')], ...HYPHEN_LANGS.map(([v, l]) => [v, t(l)] as [string, string])]} />}
          </>
        )}
        <Seg
          label={t('Direction')}
          path="dir"
          value={k.dir}
          options={[
            ['ltr', t('Left to right')],
            ['rtl', t('Right to left'), t('Arabic, Hebrew…')],
          ]}
        />
        <Seg expose="overflow" exposeValue={mode} label={t('Behaviour')} value={mode} onChange={(v) => edit((l) => void (l.overflow = v === 'fit' ? undefined : v))} options={OVERFLOWS.map(([v, l, tip]) => [v, t(l), t(tip)] as [TextOverflow, string, string])} />
        {mode === 'fit' && (
          <>
            <Num expose="squeeze" exposeValue={layer.squeeze ?? 0.8} label={t('Narrower to')} value={Math.round((layer.squeeze ?? 0.8) * 100)} min={50} max={100} unit="%" onChange={(v) => edit((l) => void (l.squeeze = v / 100), `squeeze-${layer.id}`)} />
            <Num expose="minSize" exposeValue={layer.minSize ?? 0.6} label={t('Smaller to')} value={Math.round((layer.minSize ?? 0.6) * 100)} min={20} max={100} unit="%" onChange={(v) => edit((l) => void (l.minSize = v / 100), `minsize-${layer.id}`)} />
            {/* The Operator is warned when the text gets smaller than this. */}
            <Num expose={false} label={t('Warn under')} value={Math.round((layer.warnBelow ?? 0.8) * 100)} min={20} max={100} unit="%" onChange={(v) => edit((l) => void (l.warnBelow = Math.abs(v - 80) < 1e-6 ? undefined : v / 100), `warn-${layer.id}`)} />
            <Seg
              label={t('Then')}
              path="fitEnd"
              value={k.fitEnd}
              options={[
                ['clip', t('Cut')],
                ['ellipsis', '…'],
              ]}
            />
          </>
        )}
      </Section>}
    </>
  );
}

/** Font and weight, from the fonts of Assets. */
function FontRow({ layer, set }: { layer: TextLayer; set: (key: string, v: unknown) => void }) {
  return (
    <Row expose={['fontFamily', 'fontWeight']} exposeValue={{ fontFamily: layer.fontFamily, fontWeight: layer.fontWeight }} label={t('Font')}>
      <FontPick family={layer.fontFamily} weight={layer.fontWeight} onChange={(f, w) => (set('fontFamily', f), w !== layer.fontWeight && set('fontWeight', w))} />
    </Row>
  );
}

const missingFont = (l: TextLayer) => {
  const fams = useFonts.getState().families;
  return fams.length > 0 && !fams.some((f) => f.family.toLowerCase() === l.fontFamily.toLowerCase());
};

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
let probe: CanvasRenderingContext2D | null = null;
/** Characters the font has no glyph for (emoji, symbols): drawn with a fallback font. */
function fallbackChars(text: string, family: string): string[] {
  const out = new Set<string>();
  probe ??= document.createElement('canvas').getContext('2d');
  for (const g of graphemes(text)) {
    if (/^[\p{L}\p{N}\p{P}\s]+$/u.test(g)) continue;
    if (EMOJI_RE.test(g)) {
      out.add(g);
      continue;
    }
    if (!probe) continue;
    probe.font = `40px "${family}", monospace`;
    const a = probe.measureText(g).width;
    probe.font = `40px "${family}", serif`;
    if (Math.abs(probe.measureText(g).width - a) > 0.3) out.add(g);
  }
  return [...out];
}

export default defineWidget({
  id: 'text',
  type: 'text',
  label: 'Text',
  group: 'Shapes & tools',
  icon: Type,
  create: () => ({}),
  ownsLook: true,
  content: ['text'],
  // A scrolling text moves with its time on air.
  live: (l) => !!l.scroll && l.scroll !== 'none',
  ageOnly: true,
  Render: ({ layer, r, w, h, data, designer, time }) => <Render layer={layer} r={r} w={w} h={h} data={data} designer={designer} lang={time.lang} ageSecs={time.ageSecs} fps={time.fps} />,
  Inspector: ({ layer, data, template, edit }) => <Inspector layer={layer} data={data} template={template} edit={edit} />,
  warnings: (layer, { data }) => {
    const out: Warning[] = [];
    const text = shownText(layer, data);
    if (!text.trim()) return [{ level: 'info', text: t('Empty text: nothing goes on air; the box keeps its size.') }];
    if (missingFont(layer)) out.push({ level: 'warn', text: t('Font “{font}” is missing on the server: replaced by Inter.', { font: layer.fontFamily }), op: true });
    const fb = fallbackChars(text, layer.fontFamily);
    if (fb.length) out.push({ level: 'info', text: t('{chars} not in {font}: drawn with a fallback font (colour emoji / symbols), never an empty box.', { chars: fb.join(' '), font: layer.fontFamily }) });
    if (/[؀-ۿݐ-ݿ]/.test(text)) out.push({ level: 'info', text: t('Arabic: the on-air renderer has no text shaping, the letters are drawn unjoined there.'), op: true });
    return out;
  },
});
