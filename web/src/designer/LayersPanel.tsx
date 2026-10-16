import { BarChart3, ChevronDown, ChevronRight, Circle, Clock, Copy, Eye, EyeOff, Folder, GalleryHorizontal, Hash, Image, Keyboard, Lock, MoveHorizontal, MoveVertical, QrCode, Repeat, SlidersHorizontal, Square, Trash2, Type, Unlock, Watch } from 'lucide-react';
import { useState } from 'react';
import { childrenMap } from '../engine/Scene';
import type { Layer, LayerType, Template } from '../engine/types';
import { descendants, duplicateLayers, findLayer, useDesigner } from './designerStore';

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
};

type DropPos = 'above' | 'below' | 'into';

function moveLayer(t: Template, id: string, targetId: string, pos: DropPos) {
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
    // Panel shows top-most first, so "above" means later in paint order.
    t.layers.splice(pos === 'above' ? tIdx + 1 : tIdx, 0, layer);
  }
}

export function LayersPanel() {
  const { template, selected, select, update } = useDesigner();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  if (!template) return null;
  const tree = childrenMap(template.layers, true);

  const row = (l: Layer, depth: number): React.ReactNode => {
    const Icon = ICONS[l.type];
    const kids = [...(tree.get(l.id) ?? [])].reverse();
    const isSel = selected.includes(l.id);
    return (
      <div key={l.id}>
        <div
          className={`layer-row ${isSel ? 'selected' : ''} ${drop?.id === l.id ? `drop-${drop.pos}` : ''} ${l.visible ? '' : 'dim'}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/layer', l.id)}
          onDragOver={(e) => {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const y = (e.clientY - r.top) / r.height;
            const pos: DropPos = l.type === 'group' && y > 0.33 && y < 0.75 ? 'into' : y < 0.5 ? 'above' : 'below';
            setDrop({ id: l.id, pos });
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => {
            const id = e.dataTransfer.getData('text/layer');
            const d = drop;
            setDrop(null);
            if (id && d) update((t) => moveLayer(t, id, d.id, d.pos));
          }}
          onClick={(e) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) select(isSel ? selected.filter((s) => s !== l.id) : [...selected, l.id]);
            else select([l.id]);
          }}
          onDoubleClick={() => setRenaming(l.id)}
        >
          <span
            className="twirl"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed({ ...collapsed, [l.id]: !collapsed[l.id] });
            }}
          >
            {kids.length > 0 ? collapsed[l.id] ? <ChevronRight size={12} /> : <ChevronDown size={12} /> : null}
          </span>
          <Icon size={13} className="layer-icon" />
          {renaming === l.id ? (
            <input
              autoFocus
              className="rename"
              defaultValue={l.name}
              onBlur={(e) => {
                const v = e.target.value.trim();
                setRenaming(null);
                if (v && v !== l.name) update((t) => void (findLayer(t, l.id)!.name = v));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(null);
                e.stopPropagation();
              }}
            />
          ) : (
            <span className="layer-name">{l.name}</span>
          )}
          <button
            className="icon-btn ghost"
            title={l.visible ? 'Hide' : 'Show'}
            onClick={(e) => {
              e.stopPropagation();
              update((t) => void (findLayer(t, l.id)!.visible = !l.visible));
            }}
          >
            {l.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <button
            className={`icon-btn ghost ${l.locked ? 'on' : ''}`}
            title={l.locked ? 'Unlock' : 'Lock'}
            onClick={(e) => {
              e.stopPropagation();
              update((t) => void (findLayer(t, l.id)!.locked = !l.locked));
            }}
          >
            {l.locked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
          <button
            className="icon-btn ghost del"
            title="Duplicate (Ctrl+D)"
            onClick={(e) => {
              e.stopPropagation();
              duplicateLayers([l.id]);
            }}
          >
            <Copy size={13} />
          </button>
          <button
            className="icon-btn ghost del"
            title="Delete (Del)"
            onClick={(e) => {
              e.stopPropagation();
              const kids = descendants(template, l.id).length;
              if (kids && !confirm(`Delete “${l.name}” and the ${kids} layer(s) inside it?`)) return;
              update((t) => {
                const ids = new Set([l.id, ...descendants(t, l.id)]);
                t.layers = t.layers.filter((x) => !ids.has(x.id));
              });
              select(selected.filter((s) => s !== l.id));
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
        {!collapsed[l.id] && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  };

  const roots = [...(tree.get(null) ?? [])].reverse();
  return (
    <div className="layers-list">
      {roots.length === 0 && <div className="empty">No layers yet. Add one from the toolbar.</div>}
      {roots.map((l) => row(l, 0))}
    </div>
  );
}
