// Right-click menu of the timeline's layer and property rows: copy / paste
// layers and animations (clipboard.ts).
import { ClipboardCopy, ClipboardPaste, Copy, Scissors } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Prop } from '../engine/types';
import { t } from '../i18n';
import { animatedProps, copyAnimation, copyLayers, cutLayers, pasteAnimation, pasteAnimationOnRow, pasteLayers, rowMapping, useClipboard } from './clipboard';
import { duplicateLayers, findLayer, useDesigner } from './designerStore';

export interface ClipMenuAt {
  x: number;
  y: number;
  layerId: string;
  /** A property row (Position…): its properties and label. */
  row?: { props: Prop[]; label: string };
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

export function ClipboardMenu({ at, onClose }: { at: ClipMenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
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
    <div ref={ref} className="menu project-menu clip-menu" style={{ position: 'fixed', left: Math.min(at.x, window.innerWidth - 250), top: Math.min(at.y, window.innerHeight - (at.row ? 110 : 250)), right: 'auto' }} onContextMenu={(e) => e.preventDefault()}>
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
    </div>,
    document.body,
  );
}
