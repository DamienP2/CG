import { ChartColumn, Map as MapIcon, Pentagon, PenTool, ScrollText, Table, Trophy, BarChart3, Circle, Clock, Folder, GalleryHorizontal, Hash, Image, Keyboard, MoveHorizontal, MoveVertical, QrCode, Repeat, SlidersHorizontal, Square, Type, Watch } from 'lucide-react';
import type { LayerType, Template } from '../engine/types';
import { descendants, findLayer } from './designerStore';

/** Layer type icons (timeline, menus). */
export const ICONS: Record<LayerType, typeof Square> = {
  group: Folder,
  rect: Square,
  ellipse: Circle,
  text: Type,
  image: Image,
  clock: Clock,
  ticker: MoveHorizontal,
  roll: MoveVertical,
  analogClock: Watch,
  counter: Hash,
  progress: SlidersHorizontal,
  rotator: Repeat,
  typewriter: Keyboard,
  slideshow: GalleryHorizontal,
  qrCode: QrCode,
  barChart: BarChart3,
  polygon: Pentagon,
  pen: PenTool,
  table: Table,
  credits: ScrollText,
  chart: ChartColumn,
  map: MapIcon,
  scoreboard: Trophy,
};

export type DropPos = 'above' | 'below' | 'into';

/** Moves a layer above / below another (as listed, top-most first) or into a group. */
export function moveLayer(t: Template, id: string, targetId: string, pos: DropPos) {
  if (id === targetId || descendants(t, id).includes(targetId)) return;
  const idx = t.layers.findIndex((l) => l.id === id);
  const [layer] = t.layers.splice(idx, 1);
  const target = findLayer(t, targetId)!;
  const tIdx = t.layers.indexOf(target);
  if (pos === 'into') {
    layer.parent = target.id;
    t.layers.push(layer);
  } else {
    layer.parent = target.parent ?? null;
    // Listed top-most first, so "above" means later in paint order.
    t.layers.splice(pos === 'above' ? tIdx + 1 : tIdx, 0, layer);
  }
}
