import { useEffect, useState } from 'react';
import { Viewport } from '../engine/Scene';
import { useApp } from '../store';
import { Program } from './Program';
import { OutputDebug } from './OutputDebug';
import { useFonts } from '../engine/fonts';
import { preloadProject } from '../engine/preload';

/**
 * HTML5 output of one channel picture: a transparent, chrome-less page meant
 * for browser sources (OBS, vMix, CasparCG HTML producer…).
 * URL: /output/<path> (an HTML5 output's address: its picture and background),
 * or /output/<channel>[/<rendition>]. Query params: `scale=fit|1` (default
 * fit), `bg=<css color>` for checks, `debug` for motion measures.
 */
export function Output({ channelId: first, rendition: second, path = '' }: { channelId: string; rendition?: string | null; /** All after /output/. */ path?: string }) {
  const { connect, channels, full, live } = useApp();
  // The address of an HTML5 output (« plateau-a/16-9/1 »), else a channel's id and its rendition (older links).
  const page = channels.flatMap((c) => (c.html5 ?? []).map((h) => ({ c, h }))).find((x) => x.h.path.toLowerCase() === (path || first).toLowerCase());
  const at = page ? page.c.id : first;
  const asked = page ? null : second;
  const channelId = page?.c.id ?? at;
  const rendition = page ? (page.h.picture === 'main' ? null : page.h.picture) : asked;
  const params = new URLSearchParams(location.search);
  const fixed = params.get('scale') === '1';
  const bg = params.get('bg') ?? (page?.h.background || 'transparent');
  // Measures of the page's motion where it runs (vMix, OBS…).
  const debug = params.has('debug');
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });

  useEffect(() => {
    document.documentElement.classList.add('output-mode');
    // The address as asked (the server knows the HTML5 outputs' addresses).
    connect(path || first);
    const onResize = () => setSize({ w: innerWidth, h: innerHeight });
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, [connect, path, first]);

  const channel = channels.find((c) => c.id === channelId);
  const shownProject = channel?.projectId ? full[channel.projectId] : undefined;
  // Its fonts and pictures ready before they go on air (once the server's fonts are declared).
  const fontsDeclared = useFonts((s) => s.families.length > 0);
  useEffect(() => {
    if (shownProject) preloadProject(shownProject);
  }, [shownProject, fontsDeclared]);
  if (!channel) return null;
  const picture = channel.renditions.find((r) => r.id === rendition) ?? channel;
  const project = channel.projectId ? full[channel.projectId] : undefined;
  const scale = fixed ? 1 : Math.min(size.w / picture.width, size.h / picture.height);
  // No project loaded: what the other outputs show (the server draws the
  // built-in designs; a new address when the settings change).
  const pictureId = picture === channel ? 'main' : rendition!;
  const key = [channel.name, picture.width, picture.height, channel.frameRate.num, channel.frameRate.den, picture.slateStyle].join(' ');
  const slate = channel.projectId ? '' : picture.slateStyle === 'custom' ? (picture.slate ?? '') : `/api/channels/${encodeURIComponent(channelId)}/slate.png?${new URLSearchParams({ picture: pictureId, v: key })}`;
  return (
    <div style={{ position: 'fixed', inset: 0, background: bg, overflow: 'hidden' }}>
      <Viewport width={picture.width} height={picture.height} scale={scale}>
        {project && <Program project={project} live={live[channelId]} width={picture.width} height={picture.height} bus={picture === channel ? 0 : ((picture as { bus?: number }).bus ?? 0)} />}
        {/* Filling the frame, as on the other outputs. */}
        {slate && <img src={slate} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      </Viewport>
      {debug && <OutputDebug fps={channel.frameRate.num / channel.frameRate.den || 25} />}
    </div>
  );
}
