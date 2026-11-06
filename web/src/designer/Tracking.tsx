import { Crosshair } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../store';
import { t, tc } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { NumberField, Segmented } from '../ui/fields';
import { anchorFrom, useCameras } from '../engine/tracking';
import type { CameraSample, Layer, Template } from '../engine/types';
import type { InputInfo } from '../outputs/types';
import { Row as KitRow, Section as SpecSection, SliderNum } from '../widgets/kit';
import { num } from '../perf/format';
import { findLayer, useDesigner } from './designerStore';

/**
 * Camera tracking in the Designer: the camera a template follows, its
 * layers anchored to the scene, and the camera the stage shows (the one
 * received, or one moved by hand).
 */

/** The camera the stage shows instead of the received one (null: the received one). */
export const useTrackPreview = create<{ sim: CameraSample | null }>(() => ({ sim: null }));

const SIM: CameraSample = { pan: 0, tilt: 0, roll: 0, focal: 35, sensor: 0 };

/** The tracking inputs of the server. */
function useTrackingInputs(): InputInfo[] {
  const [list, setList] = useState<InputInfo[]>([]);
  useEffect(() => {
    let alive = true;
    api<InputInfo[]>('GET', '/api/inputs')
      .then((all) => alive && setList(all.filter((i) => i.kind === 'tracking')))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

/** Where the template's camera looks now in the Designer (simulated or received). */
function useShownCamera(template: Template): CameraSample | undefined {
  const sim = useTrackPreview((s) => s.sim);
  const received = useCameras((s) => (template.camera ? s.samples[template.camera] : undefined));
  return sim ?? received;
}

const deg = (v: number) => `${v.toFixed(1).replace('.', ',').replace('-', '−')}°`;

/** A camera's values, as they come (the stage's camera when it is simulated). */
function LiveValues({ cam }: { cam?: CameraSample }) {
  const cells: [string, string][] = [
    ['Pan', cam ? deg(cam.pan) : '—'],
    ['Tilt', cam ? deg(cam.tilt) : '—'],
    [t('Focal length'), cam?.focal ? `${num(cam.focal, 1)} mm` : '—'],
    [t('Focus'), cam?.focus ? `${num(cam.focus, 2)} m` : '—'],
  ];
  return (
    <div className="tpl-live">
      {cells.map(([k, v]) => (
        <span key={k}>
          <small>{k}</small>
          <strong>{v}</strong>
        </span>
      ))}
    </div>
  );
}

/** Template › Camera tracking: the camera its anchored layers follow, and the stage's camera. */
export function TemplateTracking({ template }: { template: Template }) {
  const update = useDesigner((s) => s.update);
  const inputs = useTrackingInputs();
  const sim = useTrackPreview((s) => s.sim);
  const live = useCameras((s) => (template.camera ? s.samples[template.camera] : undefined));
  if (!inputs.length && !template.camera) return null;
  const dot = (on: boolean) => <span className={`tpl-cam-dot ${on ? 'on' : ''}`} />;
  const options = [
    { value: '', label: t('No camera'), icon: <Crosshair size={14} className="tpl-cam-none" /> },
    ...inputs.map((i) => ({
      value: i.id,
      label: i.name,
      icon: dot(i.live),
      sub: i.live ? `${t('Reception')}${i.fps ? ` · ${num(i.fps, 0)} Hz` : ''}` : t('Waiting for the camera…'),
    })),
  ];
  if (template.camera && !inputs.some((i) => i.id === template.camera)) options.push({ value: template.camera, label: t('(missing: {source})', { source: template.camera }), icon: dot(false), sub: t('Waiting for the camera…') });
  const set = (k: keyof CameraSample, v: number) => useTrackPreview.setState((s) => ({ sim: { ...(s.sim ?? SIM), [k]: v } }));
  return (
    <>
      <div className="tpl-field">
        <span className="tpl-label">{t('Camera tracking')}</span>
        <Dropdown value={template.camera ?? ''} title={t('Camera tracking')} options={options} onChange={(v) => update((tt) => void (v ? (tt.camera = v) : delete tt.camera))} />
      </div>
      {template.camera && (
        <div className="tpl-field">
          <span className="tpl-label">{t('Preview')}</span>
          <Segmented
            value={sim ? 'sim' : 'live'}
            onChange={(v) => useTrackPreview.setState({ sim: v === 'sim' ? { ...SIM, ...useCameras.getState().samples[template.camera!] } : null })}
            options={[
              { value: 'live', label: t('Camera') },
              { value: 'sim', label: t('Simulated') },
            ]}
          />
          {sim ? (
            <div className="tpl-sim">
              <KitRow label="Pan">
                <SliderNum value={sim.pan} onChange={(v) => set('pan', v)} min={-170} max={170} step={0.1} precision={1} unit="°" />
              </KitRow>
              <KitRow label="Tilt">
                <SliderNum value={sim.tilt} onChange={(v) => set('tilt', v)} min={-90} max={90} step={0.1} precision={1} unit="°" />
              </KitRow>
              <KitRow label={t('Focal length')}>
                <SliderNum value={sim.focal || 35} onChange={(v) => set('focal', v)} min={8} max={300} step={1} unit="mm" />
              </KitRow>
            </div>
          ) : (
            <LiveValues cam={live} />
          )}
        </div>
      )}
    </>
  );
}

/**
 * Layer › Tracking, for the layers at the top of the template (a folder
 * there carries its layers): fixed on the screen or anchored to the set,
 * and then where, how far, with the zoom, in front of the people or behind.
 */
export function LayerAnchor({ layer, template }: { layer: Layer; template: Template }) {
  const update = useDesigner((s) => s.update);
  const cam = useShownCamera(template);
  if (!template.camera || layer.parent) return null;
  const edit = (fn: (l: Layer) => void) => update((tt) => fn(findLayer(tt, layer.id)!));
  const anchor = layer.anchor;
  const none = cam ? undefined : t('Nothing received from the camera');
  // Anchoring takes where the camera is focused as the distance, when it says.
  const focus = cam?.focus && cam.focus > 0 ? cam.focus : 0;
  return (
    <SpecSection id="layer-tracking" title={tc('camera', 'Tracking')}>
      <KitRow label={t('Anchoring')}>
        <Segmented
          className="grow"
          value={anchor ? 'set' : 'screen'}
          onChange={(v) => edit((l) => void (v === 'set' && cam ? (l.anchor = anchorFrom(cam, true, focus)) : delete l.anchor))}
          options={[
            { value: 'screen', label: tc('trk', 'Screen') },
            { value: 'set', label: tc('trk', 'Set'), disabled: !anchor && !cam, title: none },
          ]}
        />
      </KitRow>
      {anchor && (
        <>
          <KitRow label={t('Anchor')}>
            <span className="tpl-anchor">
              <span className="grow">
                {deg(anchor.pan)} · {deg(anchor.tilt)}
              </span>
              <button className="btn small" disabled={!cam} title={none} onClick={() => cam && edit((l) => void (l.anchor = anchorFrom(cam, l.anchor?.zoom, focus || l.anchor?.distance)))}>
                {t('Anchor here')}
              </button>
            </span>
          </KitRow>
          <KitRow label={t('Distance')}>
            <span className="tpl-anchor">
              <Segmented
                className="grow"
                value={anchor.distance ? 'fixed' : 'far'}
                onChange={(v) => edit((l) => void (l.anchor && (v === 'far' ? delete l.anchor.distance : (l.anchor.distance = focus || 5))))}
                options={[
                  { value: 'far', label: tc('trk', 'Infinite') },
                  { value: 'fixed', label: tc('distance', 'Fixed') },
                ]}
              />
              {!!anchor.distance && (
                <span className="tpl-distance">
                  <NumberField value={anchor.distance} min={0.3} max={500} step={0.1} precision={1} suffix="m" onChange={(v) => edit((l) => void (l.anchor && (l.anchor.distance = Math.max(0.3, v))))} />
                </span>
              )}
            </span>
          </KitRow>
          <KitRow label="Zoom">
            <Segmented
              className="grow"
              value={anchor.zoom ? 'follow' : 'still'}
              onChange={(v) => edit((l) => void (l.anchor && (l.anchor.zoom = v === 'follow')))}
              options={[
                { value: 'follow', label: tc('trk', 'Follows') },
                { value: 'still', label: tc('trk', 'Ignores') },
              ]}
            />
          </KitRow>
          <KitRow label={t('People')}>
            <Segmented
              className="grow"
              value={anchor.behind ? 'behind' : 'front'}
              onChange={(v) => edit((l) => void (l.anchor && (v === 'behind' ? (l.anchor.behind = true) : delete l.anchor.behind)))}
              options={[
                { value: 'front', label: tc('trk', 'In front') },
                { value: 'behind', label: tc('trk', 'Behind') },
              ]}
            />
          </KitRow>
        </>
      )}
    </SpecSection>
  );
}
