// « Voir dans »: the widget being built, as it renders in a picture (16:9 or 9:16) with its safe
// areas, at a place of the picture. Seen only: the Graphisme edits it at its own size.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { placeWidget } from '../engine/built';
import { defaultData } from '../engine/evaluate';
import { LiveTime } from '../engine/LiveTime';
import { Scene, Viewport } from '../engine/Scene';
import { MARKER_MODEL, type Template, type WidgetDef } from '../engine/types';
import { t } from '../i18n';
import type { PreviewPlace } from '../designer/builderUi';

export const PLACES: [PreviewPlace, string][] = [
  ['bl', 'Bottom left'],
  ['bc', 'Bottom centre'],
  ['br', 'Bottom right'],
  ['tl', 'Top left'],
  ['tr', 'Top right'],
  ['c', 'Centre'],
];

export function FormatPreview({ def, picture, place, lang }: { def: WidgetDef; picture: { width: number; height: number }; place: PreviewPlace; lang: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 800, height: 450 });
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // Its padding, and the hint under the picture.
    const ro = new ResizeObserver(() => setRoom({ width: el.clientWidth - 64, height: el.clientHeight - 64 - 40 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = picture.width;
  const H = picture.height;
  const s = Math.max(0.05, Math.min(room.width / W, room.height / H));
  // In the action-safe area (5 %); a widget larger than it is made smaller to fit.
  const m = 0.05;
  const k = Math.min(1, (W * (1 - 2 * m)) / def.width, (H * (1 - 2 * m)) / def.height);
  const w = def.width * k;
  const h = def.height * k;
  const x = place === 'bl' || place === 'tl' ? W * m : place === 'br' || place === 'tr' ? W * (1 - m) - w : (W - w) / 2;
  const y = place === 'tl' || place === 'tr' ? H * m : place === 'c' ? (H - h) / 2 : H * (1 - m) - h;
  const tpl = useMemo(() => {
    const layers = placeWidget(def, 'preview', 0, 0);
    return { id: `preview:${def.id}`, name: def.name, duration: 1, markers: [], fields: [], layers, zone: '', revision: 0, markerModel: MARKER_MODEL } as unknown as Template;
  }, [def]);
  const data = useMemo(() => defaultData(tpl), [tpl]);
  return (
    <div className="wb-fmt" ref={wrap}>
      <div className="wb-fmt-pic" style={{ width: W * s, height: H * s }}>
        <div className="wb-fmt-safe" style={{ inset: `${5}%` }} />
        <div className="wb-fmt-safe title" style={{ inset: `${10}%` }} />
        <div style={{ position: 'absolute', left: x * s, top: y * s }}>
          <Viewport width={def.width} height={def.height} scale={s * k} style={{ overflow: 'visible' }}>
            <LiveTime ageSecs={0} ticking="all" settled lang={lang}>
              <Scene template={tpl} frame={0} data={data} />
            </LiveTime>
          </Viewport>
        </div>
        <span className="wb-fmt-tag">
          {W} × {H}
          {k < 1 ? ` · ${t('widget at {n} %', { n: Math.round(k * 100) })}` : ''}
        </span>
      </div>
      <p className="wb-fmt-hint">{t('Seen only: choose « Widget size » to change it.')}</p>
    </div>
  );
}
