import type { Layer, Template } from '../engine/types';
import { newId } from '../engine/evaluate';
import { useApp } from '../store';
import { useDesigner } from './designerStore';

/*
 * Mask folders: a layer used as a mask becomes a folder (one timeline row);
 * the layers dragged into it are seen in its shape (Include) or outside it
 * (Exclude). The renderers draw them so (Scene.tsx, cg-render).
 */

/** The mask folder a layer is the mask of, if it is one. */
export const maskFolderOf = (tpl: Template, id: string) => tpl.layers.find((l) => l.type === 'group' && l.mask?.layer === id) as (Layer & { type: 'group' }) | undefined;

/**
 * The topmost of `ids` (same folder as it) used as a mask: a folder made
 * where it is, holding it (as its first row) and the other ones.
 */
export function makeMask(ids: string[], exclude: boolean) {
  const st = useDesigner.getState();
  const project = useApp.getState().project;
  let mask = '';
  st.update((tpl) => {
    const order = tpl.layers.map((l) => l.id);
    const picked = tpl.layers.filter((l) => ids.includes(l.id));
    if (!picked.length) return;
    // The topmost in paint order (the last drawn) is the mask.
    const maskLayer = picked.reduce((a, b) => (order.indexOf(b.id) > order.indexOf(a.id) ? b : a));
    const others = picked.filter((l) => l.id !== maskLayer.id && l.parent === maskLayer.parent);
    const parent = maskLayer.parent ? tpl.layers.find((l) => l.id === maskLayer.parent) : undefined;
    // As big as what it is in: its children keep their places.
    const width = Number(parent?.props.width ?? project?.width ?? 1920);
    const height = Number(parent?.props.height ?? project?.height ?? 1080);
    const group: Layer = { id: newId(), name: maskLayer.name, type: 'group', clip: false, parent: maskLayer.parent ?? null, visible: true, locked: false, tracks: {}, bindings: {}, props: { x: 0, y: 0, width, height }, mask: { layer: maskLayer.id, exclude } } as Layer;
    mask = maskLayer.id;
    const moved = [...others, maskLayer];
    const rest = tpl.layers.filter((l) => !moved.includes(l));
    // The folder where the mask was; the others under it, the mask on top (its first row).
    const at = rest.findIndex((l) => order.indexOf(l.id) > order.indexOf(maskLayer.id));
    const inside = moved.map((l) => ({ ...l, parent: group.id }));
    const placed = [group, ...inside.sort((a, b) => (a.id === maskLayer.id ? 1 : b.id === maskLayer.id ? -1 : order.indexOf(a.id) - order.indexOf(b.id)))];
    tpl.layers = at < 0 ? [...rest, ...placed] : [...rest.slice(0, at), ...placed, ...rest.slice(at)];
  });
  // The mask stays selected: its Mask section open in the inspector.
  if (mask) st.select([mask]);
}

/** A mask folder undone: its layers back where it was, the folder gone. */
export function stopMasking(folderId: string) {
  const st = useDesigner.getState();
  let mask = '';
  st.update((tpl) => {
    const f = tpl.layers.find((l) => l.id === folderId);
    if (!f) return;
    mask = f.type === 'group' ? (f.mask?.layer ?? '') : '';
    tpl.layers = tpl.layers.filter((l) => l.id !== folderId).map((l) => (l.parent === folderId ? { ...l, parent: f.parent ?? null } : l));
  });
  st.select(mask ? [mask] : []);
}
