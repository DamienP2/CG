import { useEffect, useState } from 'react';
import { Check, Lightbulb, Play, Radio, PenTool, Server } from 'lucide-react';
import { api, can, useApp } from '../store';
import { lang, t, useLang } from '../i18n';
import { Segmented } from '../ui/fields';
import type { Cat } from './types';
import { CAT_NAMES, CHAPTERS } from './chapters';
import { LESSONS } from './lessons';
import { TIPS } from './tips';
import { startLesson, useDone } from './store';
import { say } from './Coach';
import { designerTour, operatorTour } from './tours';

interface Example {
  id: string;
  name: string;
  category: string;
  tags: string[];
  en?: { name: string };
}

/** Key names in English. */
const EN_KEYS: Record<string, string> = { Espace: 'Space', molette: 'wheel', Molette: 'Wheel', Début: 'Home', Fin: 'End', Échap: 'Esc', Suppr: 'Del', 'Double-clic': 'Double-click', Entrée: 'Enter' };
const keyName = (k: string) => (lang() === 'en' ? (EN_KEYS[k] ?? k) : k);

const ICON: Record<Cat, React.ReactNode> = { admin: <Server size={15} />, designer: <PenTool size={15} />, operator: <Radio size={15} /> };

/** The parts a role sees: Administration for admins, Designer for designers, Operator for all. */
export function partsFor(role: string | undefined): Cat[] {
  if (role === 'admin') return ['admin', 'designer', 'operator'];
  if (role === 'designer') return ['designer', 'operator'];
  return ['operator'];
}

/** « Apprendre »: the lessons of one's role, the examples, the tips. */
export function LearnPage() {
  useLang((s) => s.lang);
  const user = useApp((s) => s.auth?.user);
  const parts = partsFor(user?.role);
  const [tab, setTab] = useState<'lessons' | 'examples' | 'tips'>('lessons');
  const [part, setPart] = useState<Cat>(parts.includes('designer') ? 'designer' : parts[0]);
  const done = useDone();
  const [examples, setExamples] = useState<Example[] | null>(null);
  useEffect(() => {
    document.title = `${t('Learn')} · Strata Graphics`;
    api<Example[]>('GET', '/api/examples')
      .then(setExamples)
      .catch(() => setExamples([]));
  }, []);
  const lessonsOf = (c: Cat) => LESSONS.filter((l) => l.cat === c);
  const total = parts.reduce((n, c) => n + lessonsOf(c).length, 0);
  const designs = can.design(user);

  return (
    <div className="library learn">
      <div className="library-inner wide">
        <div className="settings-head">
          <div>
            <h1>{t('Learn')}</h1>
            <p className="muted">
              {t('{n} lessons', { n: total })} · {t('{n} examples', { n: examples?.length ?? 0 })}
            </p>
          </div>
          <div className="spacer" />
          <div className="learn-tabs">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'lessons', label: t('Lessons') },
                { value: 'examples', label: t('Examples') },
                { value: 'tips', label: t('Tips') },
              ]}
            />
          </div>
        </div>

        {tab === 'lessons' && (
          <div className="learn-split">
            <nav className="learn-parts">
              {parts.map((c) => {
                const list = lessonsOf(c);
                const n = list.filter((l) => done.has(l.id)).length;
                return (
                  <button key={c} className={`learn-part ${c === part ? 'on' : ''}`} onClick={() => setPart(c)}>
                    <span className="learn-ic">{ICON[c]}</span>
                    <span className="learn-pn">
                      <b>{say(CAT_NAMES[c])}</b>
                      <small>
                        {n}/{list.length}
                      </small>
                      <span className="learn-bar">
                        <i style={{ width: `${list.length ? (n / list.length) * 100 : 0}%` }} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </nav>
            <div className="learn-chapters">
              {CHAPTERS[part].map((ch) => {
                const list = lessonsOf(part).filter((l) => l.chapter === ch.id);
                if (!list.length) return null;
                return (
                  <section key={ch.id} className="learn-chapter">
                    <h3>{say(ch.title)}</h3>
                    <div className="learn-grid">
                      {list.map((l, i) => (
                        <button key={l.id} className={`learn-lesson ${done.has(l.id) ? 'done' : ''}`} onClick={() => void startLesson(l.id)}>
                          <span className="learn-n">{done.has(l.id) ? <Check size={12} /> : i + 1}</span>
                          <span className="learn-t">{say(l.title)}</span>
                          <span className="learn-go">
                            <Play size={11} />
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {tab === 'examples' && (
          <div className="learn-examples">
            {(examples ?? []).map((e) => {
              const name = lang() === 'en' && e.en?.name ? e.en.name : e.name;
              return (
                <article key={e.id} className="learn-ex">
                  <div className="learn-ex-img" style={{ backgroundImage: `url(/api/examples/${encodeURIComponent(e.id)}/cover.png?w=480)` }}>
                    <span>{e.category}</span>
                  </div>
                  <div className="learn-ex-b">
                    <b>{name}</b>
                    <div className="learn-tags">
                      {e.tags.slice(0, 4).map((x) => (
                        <i key={x}>{x}</i>
                      ))}
                    </div>
                    <button className="btn small" onClick={() => void startLesson((designs ? designerTour : operatorTour)(e.id, name).id)}>
                      <Play size={11} /> {designs ? t('How it is made') : t('Practise')}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {tab === 'tips' &&
          parts.map((c) => (
            <section key={c} className="learn-tips">
              <h3>
                <span className="learn-ic">{ICON[c]}</span>
                {say(CAT_NAMES[c])}
              </h3>
              <div className="learn-tip-grid">
                {TIPS[c].map((x, i) => (
                  <div key={i} className="learn-tip">
                    {x.keys ? (
                      x.keys.split(' / ').map((alt, j) => (
                        <span key={j} className="learn-keys">
                          {j > 0 && <span className="learn-sep">/</span>}
                          {alt.split(' + ').map((k, m) => (
                            <span key={m}>
                              {m > 0 && <span className="learn-sep">+</span>}
                              <kbd>{keyName(k)}</kbd>
                            </span>
                          ))}
                        </span>
                      ))
                    ) : (
                      <span className="learn-bulb">
                        <Lightbulb size={14} />
                      </span>
                    )}
                    <span>{say(x.say)}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}
