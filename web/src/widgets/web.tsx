// Web page: a web address or some HTML in the graphic. Only a browser draws it: the HTML5 outputs and
// the previews show it; the engine's own outputs (SDI, NDI, ST 2110) leave its box empty.
// Model: crates/cg-core/src/wid/web.rs.
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { interpolateText } from '../engine/evaluate';
import { Btns, Content, defineWidget, Note, Num, Section, Seg, Toggle, type Warning } from './kit';

export interface Config {
  source?: 'url' | 'html';
  url?: string;
  html?: string;
  /** Loaded again every N seconds (0 = never). */
  refresh?: number;
  /** Page zoom, %. */
  zoom?: number;
  /** The page's own background shows. */
  opaque?: boolean;
}
export interface State {
  reloadedAt?: number;
}
type WebLayer = Config & { id: string };

const cfg = (c: Config) => ({ source: c.source ?? 'url', url: c.url ?? 'https://example.com', html: c.html ?? '', refresh: Math.max(0, c.refresh ?? 0), zoom: Math.max(10, c.zoom ?? 100), opaque: !!c.opaque });

/** Only http(s) pages (no javascript: or file: addresses). */
const safeUrl = (u: string) => (/^https?:\/\//i.test(u.trim()) ? u.trim() : '');

function View({ layer, w, h, data, state, nowMs, designer }: { layer: WebLayer; w: number; h: number; data: Record<string, string>; state: unknown; nowMs: number; designer?: boolean }) {
  const k = cfg(layer);
  // Reloads: the operator's, and every `refresh` seconds.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!k.refresh) return;
    const t = setInterval(() => setTick((x) => x + 1), k.refresh * 1000);
    return () => clearInterval(t);
  }, [k.refresh]);
  const z = k.zoom / 100;
  const url = safeUrl(interpolateText(k.url, data));
  const key = `${(state as State | undefined)?.reloadedAt ?? 0}-${tick}`;
  void nowMs;
  const frame =
    k.source === 'html' ? (
      <iframe key={key} title={layer.id} srcDoc={interpolateText(k.html, data)} sandbox="allow-scripts" style={{ width: w / z, height: h / z, border: 0, transform: `scale(${z})`, transformOrigin: '0 0', background: k.opaque ? '#fff' : 'transparent', colorScheme: 'normal', pointerEvents: designer ? 'none' : undefined }} />
    ) : url ? (
      <iframe key={key} title={layer.id} src={url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" style={{ width: w / z, height: h / z, border: 0, transform: `scale(${z})`, transformOrigin: '0 0', background: k.opaque ? '#fff' : 'transparent', colorScheme: 'normal', pointerEvents: designer ? 'none' : undefined }} />
    ) : null;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {frame}
      {designer && !frame && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', border: '4px dashed rgba(255,255,255,.35)', color: 'rgba(255,255,255,.6)', font: '600 26px Inter, sans-serif' }}>Web page: an http(s) address</div>}
    </div>
  );
}

export default defineWidget({
  id: 'web',
  type: 'web',
  label: 'Web page',
  group: 'Data',
  icon: Globe,
  presets: [
    { label: 'Web page', hint: 'A web address (HTML5 outputs)' },
    { label: 'Iframe', hint: 'Your HTML code (HTML5 outputs)', patch: { source: 'html', html: '<div style="font:700 64px sans-serif;color:#fff">Hello</div>' } },
  ],
  create: () => ({ source: 'url', url: 'https://example.com', zoom: 100, props: { width: 1280, height: 720 } }),
  ownsLook: true,
  content: ['url'],
  Render: ({ layer, w, h, data, state, time, designer }) => <View layer={layer as unknown as WebLayer} w={w} h={h} data={data} state={state} nowMs={time.nowMs} designer={designer} />,
  Inspector: ({ layer }) => {
    const k = cfg(layer as unknown as WebLayer);
    return (
      <>
        <Section id="web-source" title="Page">
          <Seg
            label="Source"
            path="source"
            value={k.source}
            options={[
              ['url', 'Web address'],
              ['html', 'HTML code'],
            ]}
          />
          {k.source === 'url' ? <Content label="Address" path="url" value="" placeholder="https://…" expose /> : <Content label="HTML" path="html" value="" multiline placeholder="<div>…</div>" />}
          <Num label="Zoom" path="zoom" value={k.zoom} min={10} max={400} unit="%" />
          <Num label="Reload every" path="refresh" value={k.refresh} min={0} max={86400} unit="s" />
          <Toggle label="Background" path="opaque" value={k.opaque} text="The page's own background (else transparent)" />
          <Note>Shown by browsers only: the HTML5 outputs and the previews. The SDI, NDI and ST 2110 outputs leave its box empty.</Note>
        </Section>
      </>
    );
  },
  Operator: ({ act }) => (
    <>
      <Btns list={[{ label: 'Reload the page', cls: 'violet', onClick: () => act('reload') }]} />
      <Note>On the HTML5 outputs only.</Note>
    </>
  ),
  warnings: (l) => {
    const k = cfg(l as unknown as WebLayer);
    const out: Warning[] = [{ level: 'info', text: 'Web page: HTML5 outputs and previews only (not SDI, NDI, ST 2110).' }];
    if (k.source === 'url' && k.url.trim() && !k.url.includes('{{') && !safeUrl(k.url)) out.push({ level: 'error', text: 'The address must start with http:// or https://.' });
    return out;
  },
});
