import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { lang, t, tc, useLang } from '../i18n';
import type { Step, Text } from './types';
import { lessonAfter, lessonById, nextStep, quitLesson, startLesson, useLearn } from './store';
import * as probe from './probe';

// For the lessons' checks in a browser's console (and their tests).
(window as unknown as { __learn: unknown }).__learn = { probe, useLearn };

/** A text in the language of the interface. */
export const say = (x: Text) => (lang() === 'fr' ? x.fr : x.en);

/** The element a step points at: the first one shown. */
function find(at: Step['at']): Element | null {
  if (!at) return null;
  if (typeof at === 'function') {
    const el = at();
    return el && el.getClientRects().length ? el : null;
  }
  try {
    for (const el of document.querySelectorAll(at)) if (el.getClientRects().length) return el;
  } catch {
    /* a bad selector: no place */
  }
  return null;
}

const W = 300;

/**
 * The lesson going on: a ring round the place to use and a bubble saying
 * what to do there; the step goes on by itself once done.
 */
export function Coach() {
  useLang((s) => s.lang);
  const active = useLearn((s) => s.active);
  const lesson = active ? lessonById(active.id) : undefined;
  const step = lesson && active && !active.ended ? lesson.steps[active.step] : undefined;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [ok, setOk] = useState(false);
  const bubble = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: W, h: 120 });
  const going = useRef(false);

  // A step starts: its preparation, then its test a few times a second.
  useEffect(() => {
    if (!step) return;
    going.current = false;
    setOk(false);
    void step.before?.();
    const done = () => {
      if (going.current) return;
      going.current = true;
      setOk(true);
      setTimeout(nextStep, 450);
    };
    const tick = () => {
      const el = find(step.at);
      const r = el?.getBoundingClientRect() ?? null;
      setRect((was) => (was && r && was.x === r.x && was.y === r.y && was.width === r.width && was.height === r.height ? was : r));
      if (typeof step.done === 'function') {
        try {
          if (step.done()) done();
        } catch {
          /* not there yet */
        }
      }
    };
    tick();
    const timer = setInterval(tick, 200);
    const d = step.done;
    const onClick = (e: Event) => {
      if (d && typeof d === 'object' && 'click' in d && (e.target as Element | null)?.closest?.(d.click)) done();
    };
    const onKey = (e: KeyboardEvent) => {
      if (d && typeof d === 'object' && 'key' in d && e.key.toLowerCase() === d.key.toLowerCase()) done();
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active?.id, active?.step, active?.ended]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const b = bubble.current?.getBoundingClientRect();
    if (b && (Math.abs(b.width - size.w) > 1 || Math.abs(b.height - size.h) > 1)) setSize({ w: b.width, h: b.height });
  });

  if (!active || !lesson) return null;

  if (active.ended) {
    const after = lessonAfter(lesson.id);
    return (
      <div className="lc-end" role="dialog" aria-label={t('Lesson done')}>
        <span className="lc-win">
          <Check size={20} />
        </span>
        <b>{t('Lesson done')}</b>
        <small>{say(lesson.title)}</small>
        <div className="lc-end-btns">
          <button className="btn" onClick={() => void quitLesson()}>
            {t('Lessons')}
          </button>
          {after && (
            <button className="btn primary" onClick={() => void startLesson(after.id)}>
              {t('Next lesson')}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!step) return null;

  // Where the bubble goes: under the place, else over it, else beside it; centred when none.
  const vw = innerWidth;
  const vh = innerHeight;
  const gap = 14;
  let x = vw / 2 - size.w / 2;
  let y = vh - size.h - 28;
  if (rect) {
    const big = rect.width * rect.height > vw * vh * 0.25;
    x = rect.left + rect.width / 2 - size.w / 2;
    if (big) {
      x = rect.left + 24;
      y = rect.top + 24;
    } else if (rect.bottom + gap + size.h < vh - 8) y = rect.bottom + gap;
    else if (rect.top - gap - size.h > 8) y = rect.top - gap - size.h;
    else {
      y = rect.top + rect.height / 2 - size.h / 2;
      x = rect.right + gap + size.w < vw ? rect.right + gap : rect.left - gap - size.w;
    }
  }
  x = Math.max(8, Math.min(vw - size.w - 8, x));
  y = Math.max(8, Math.min(vh - size.h - 8, y));
  const manual = !step.done || step.done === 'next';

  return (
    <>
      {rect && <div className="lc-ring" style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }} />}
      <div ref={bubble} className={`lc-bubble ${ok ? 'ok' : ''}`} style={{ left: x, top: y, width: W }} role="status" aria-live="polite">
        <div className="lc-head">
          <span className="lc-k">
            {active.step + 1}/{lesson.steps.length}
          </span>
          <span className="lc-title">{say(lesson.title)}</span>
        </div>
        <p>{say(step.say)}</p>
        <div className="lc-foot">
          <span className="lc-dots">
            {lesson.steps.map((_, i) => (
              <i key={i} className={i < active.step ? 'done' : i === active.step ? 'on' : ''} />
            ))}
          </span>
          {manual ? (
            <button className="btn small primary" onClick={() => nextStep()}>
              {t('OK')}
            </button>
          ) : (
            <button className="lc-skip" onClick={() => nextStep()}>
              {tc('learn', 'Skip')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
