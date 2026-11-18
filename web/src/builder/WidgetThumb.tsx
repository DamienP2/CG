// A widget drawn as placed in a template (its start values, its default options), fitted in a box.
import { useMemo } from 'react';
import { Puzzle } from 'lucide-react';
import { placeWidget } from '../engine/built';
import { defaultData } from '../engine/evaluate';
import { LiveTime } from '../engine/LiveTime';
import { Scene, Viewport } from '../engine/Scene';
import { MARKER_MODEL, type Template, type WidgetDef } from '../engine/types';

export function WidgetThumb({ def, box = { width: 300, height: 150 } }: { def: WidgetDef; box?: { width: number; height: number } }) {
  const tpl = useMemo(() => {
    const layers = placeWidget(def, 'thumb', 0, 0);
    return { id: `thumb:${def.id}`, name: def.name, duration: 1, markers: [], fields: [], layers, zone: '', revision: 0, markerModel: MARKER_MODEL } as unknown as Template;
  }, [def]);
  const data = useMemo(() => defaultData(tpl), [tpl]);
  const w = Math.max(1, def.width);
  const h = Math.max(1, def.height);
  // Inside the box, with a margin.
  const scale = Math.min((box.width * 0.88) / w, (box.height * 0.78) / h);
  return (
    <span className="wb-thumb-in">
      {def.layers.length ? (
        <Viewport width={w} height={h} scale={scale}>
          <LiveTime ageSecs={0} ticking={false} settled>
            <Scene template={tpl} frame={0} data={data} />
          </LiveTime>
        </Viewport>
      ) : (
        <Puzzle size={28} />
      )}
    </span>
  );
}
