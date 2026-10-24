// Right-click menu of the timeline's layer and property rows, and of the
// layers on the stage: copy / paste layers and animations (clipboard.ts),
// the layer's animation, its order and delete.
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, BringToFront, ChevronRight, ClipboardCopy, ClipboardPaste, Copy, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Prop } from '../engine/types';
import { t } from '../i18n';
import { animatedProps, copyAnimation, copyLayers, cutLayers, pasteAnimation, pasteAnimationOnRow, pasteLayers, rowMapping, useClipboard } from './clipboard';
import { descendants, duplicateLayers, findLayer, useDesigner } from './designerStore';
import { moveLayer } from './LayersPanel';

export interface ClipMenuAt {
  x: number;
  y: number;
  layerId: string;
  /** A property row (Position…): its properties and label. */
  row?: { props: Prop[]; label: string };
}

type Order = 'front' | 'forward' | 'backward' | 'back';

/** Moves layers among the layers of their group (paint order: last is in front). */
function reorder(ids: string[], how: Order) {
  const st = useDesigner.getState();
  st.update((tpl) => {
    // The front-most first when bringing forward, the back-most first when sending back: they keep their order.
    const list = tpl.layers.filter((l) => ids.includes(l.id)).map((l) => l.id);
    if (how === 'front' || how === 'forward') list.reverse();
    for (const id of list) {
      const l = findLayer(tpl, id);
      if (!l) continue;
      const sibs = tpl.layers.filter((x) => (x.parent ?? null) === (l.parent ?? null));
      const i = sibs.indexOf(l);
      const target = how === 'front' ? sibs[sibs.length - 1] : how === 'back' ? sibs[0] : how === 'forward' ? sibs[i + 1] : sibs[i - 1];
      if (!target || target.id === id) continue;
      moveLayer(tpl, id, target.id, how === 'front' || how === 'forward' ? 'above' : 'below', st.frame);
    }
  });
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

export function ClipboardMenu({ at, onClose }: { at: ClipMenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const clip = useClipboard();
  const st = useDesigner();
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const layer = st.template && findLayer(st.template, at.layerId);
  if (!layer) return null;
  // The selection when the row is part of it, else this layer.
  const targets = st.selected.includes(layer.id) ? st.selected : [layer.id];
  const run = (fn: () => void) => () => (onClose(), fn());
  const anim = clip.animation;
  const rowAnimated = at.row ? at.row.props.some((p) => layer.tracks[p]?.length) : animatedProps(layer).length > 0;
  const fits = !!anim && (!at.row || rowMapping(anim, at.row.props).length > 0);
  const ro = st.readOnly;
  return createPortal(
    <div ref={ref} className="menu project-menu clip-menu" style={{ position: 'fixed', left: Math.min(at.x, window.innerWidth - 250), top: Math.max(8, Math.min(at.y, window.innerHeight - (at.row ? 110 : 400))), right: 'auto' }} onContextMenu={(e) => e.preventDefault()}>
      {!at.row && (
        <>
          <button onClick={run(() => copyLayers(targets))}>
            <Copy size={13} /> {t('Copy')}
            <kbd>{key('C')}</kbd>
          </button>
          <button disabled={ro} onClick={run(() => cutLayers(targets))}>
            <Scissors size={13} /> {t('Cut')}
            <kbd>{key('X')}</kbd>
          </button>
          <button disabled={ro || !clip.layers} onClick={run(pasteLayers)}>
            <ClipboardPaste size={13} /> {t('Paste layers')}
            <kbd>{key('V')}</kbd>
          </button>
          <button disabled={ro} onClick={run(() => duplicateLayers(targets))}>
            <Copy size={13} /> {t('Duplicate')}
            <kbd>{key('D')}</kbd>
          </button>
          <div className="menu-sep" />
        </>
      )}
      <button disabled={!rowAnimated} title={rowAnimated ? undefined : t('No keyframes here')} onClick={run(() => copyAnimation(layer.id, at.row?.props, at.row?.label))}>
        <ClipboardCopy size={13} /> {at.row ? t('Copy the animation of {prop}', { prop: t(at.row.label) }) : t('Copy the animation')}
      </button>
      <button disabled={ro || !fits} title={anim && !fits ? t('This animation does not fit this property') : undefined} onClick={run(() => (at.row ? pasteAnimationOnRow(layer.id, at.row.props) : pasteAnimation(targets)))}>
        <ClipboardPaste size={13} /> {t('Paste the animation')}
        {anim && <em>{anim.label}</em>}
      </button>
      {!at.row && (
        <>
          <div className="menu-sep" />
          <button
            title={t('Show its keyframes in the timeline')}
            onClick={run(() => {
              const s = useDesigner.getState();
              s.set({ expanded: { ...s.expanded, [layer.id]: true } });
              requestAnimationFrame(() => document.querySelector('.tl-label.layer.selected')?.scrollIntoView({ block: 'nearest' }));
            })}
          >
            <Sparkles size={13} /> {t('Animation…')}
          </button>
          <div className="ux2-sub-wrap" onMouseEnter={() => setOrderOpen(true)} onMouseLeave={() => setOrderOpen(false)}>
            <button disabled={ro} aria-haspopup="menu" aria-expanded={orderOpen} onClick={() => setOrderOpen(!orderOpen)}>
              <BringToFront size={13} /> {t('Order')}
              <ChevronRight size={12} className="ux2-chev" />
            </button>
            {orderOpen && !ro && (
              <div className={`menu project-menu clip-menu ux2-submenu ${at.x > window.innerWidth - 480 ? 'left' : ''}`}>
                <button onClick={run(() => reorder(targets, 'front'))}>
                  <ArrowUpToLine size={13} /> {t('Bring to front')}
                </button>
                <button onClick={run(() => reorder(targets, 'forward'))}>
                  <ArrowUp size={13} /> {t('Bring forward')}
                </button>
                <button onClick={run(() => reorder(targets, 'backward'))}>
                  <ArrowDown size={13} /> {t('Send backward')}
                </button>
                <button onClick={run(() => reorder(targets, 'back'))}>
                  <ArrowDownToLine size={13} /> {t('Send to back')}
                </button>
              </div>
            )}
          </div>
          <div className="menu-sep" />
          <button
            className="danger"
            disabled={ro}
            onClick={run(() => {
              const s = useDesigner.getState();
              s.update((tpl) => {
                const ids = new Set(targets.flatMap((id) => [id, ...descendants(tpl, id)]));
                tpl.layers = tpl.layers.filter((l) => !ids.has(l.id));
              });
              s.select([]);
            })}
          >
            <Trash2 size={13} /> {t('Delete')}
            <kbd>{t('Del')}</kbd>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
