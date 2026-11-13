import type { Lesson, Step } from '../../types';
import type { Layer } from '../../../engine/types';
import { t, tc } from '../../../i18n';
import { designer, layers, shown } from '../../probe';

/*
 * designer › widgets: each lesson adds a widget from the + menu of the layers
 * (Widgets), sets one or two of its settings on the right and tries it with
 * its controls (the top of the right panel, `.pp-try`).
 */

type L = Layer & Record<string, unknown>;

/** The first layer of a type (and a test). */
const W = (type: string, test?: (l: L) => boolean): L | undefined => layers().find((l) => l.type === type && (!test || test(l as L))) as L | undefined;

/** A text of the interface: 'ctx|Text' looks it up in its context (tc). Called when shown, not at load. */
const tr = (s: string) => {
  const i = s.indexOf('|');
  return i < 0 ? t(s) : tc(s.slice(0, i), s.slice(i + 1));
};

/** The + of the layers (Widgets), or the item `label` of its menu once open. */
function menuItem(label: string): Element | null {
  const name = tc('widget', label);
  for (const b of document.querySelectorAll<HTMLElement>('.add-menu .add-grid button')) if (b.textContent?.trim() === name && b.getClientRects().length) return b;
  return shown('.menu-wrap > .opx-add');
}

/** The section of the right panel titled `title` (its text in the interface). */
function section(title: string): HTMLElement | null {
  const name = tr(title);
  for (const s of document.querySelectorAll<HTMLElement>('.inspector .pp-group'))
    if (s.querySelector(':scope > header .pp-twirl span')?.textContent?.trim() === name && s.getClientRects().length) return s;
  return null;
}

/** `sel` in the section `title`; its header while closed (to open it). */
function inSection(title: string, sel: string): Element | null {
  const s = section(title);
  if (!s) return null;
  return seen(s.querySelector(`:scope > .pp-body ${sel}`) ?? s.querySelector(':scope > header'));
}

/** The row labelled `label` (in the interface's language) in `root`. */
function rowIn(root: ParentNode | null, label: string): HTMLElement | null {
  if (!root) return null;
  for (const r of root.querySelectorAll<HTMLElement>('.wk-row')) if (r.querySelector(':scope > .prop-label')?.textContent?.trim() === label && r.getClientRects().length) return r;
  return null;
}

/** The element, scrolled into its panel's view when it is out of it (a section low in the right panel). */
function seen<T extends Element>(el: T | null | undefined): T | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o !== 'auto' && o !== 'scroll') continue;
    const v = p.getBoundingClientRect();
    if (r.top < v.top || r.bottom > v.bottom) el.scrollIntoView({ block: 'center' });
    break;
  }
  return el;
}

/** A list open (a dropdown's choices): pointed at, the bubble goes beside it, not over it. */
const list = () => shown('.dd-list');

/** A row of the section `title`; its header while closed. */
const rowOf = (title: string, label: string) => () => list() ?? seen(rowIn(section(title), tr(label)) ?? section(title)?.querySelector(':scope > header'));

/** A row of the widget's controls (top of the right panel). */
const tryRow = (label: string) => () => list() ?? seen(rowIn(document.querySelector('.pp-try'), tr(label)));

/** A button of the controls: its tooltip starts with `title`. */
function tryButton(title: string): HTMLElement | null {
  for (const b of document.querySelectorAll<HTMLElement>('.pp-try .cc-sq')) if ((b.title ?? '').startsWith(title) && b.getClientRects().length) return seen(b);
  return null;
}

/** The main button of the controls (Lire / Pause…). */
const mainButton = () => seen(shown('.pp-try .cc-sq.main'));

/** The state the controls gave the widget (its try in the Designer). */
const stateOf = (l: L | undefined): Record<string, unknown> | undefined => (l ? (designer().widgetState[l.id] as Record<string, unknown> | undefined) : undefined);

/** The step's start: the widget's state then; done when an action changed it. */
let was = '';
const acted = (find: () => L | undefined): Pick<Step, 'before' | 'done'> => ({
  before: () => {
    was = JSON.stringify(stateOf(find()) ?? null);
  },
  done: () => {
    const l = find();
    return !!l && JSON.stringify(stateOf(l) ?? null) !== was;
  },
});

/** A text typed: done once it changed and stayed the same a moment (the person stopped typing). */
let first = '';
let last = '';
let since = 0;
const typed = (get: () => unknown): Pick<Step, 'before' | 'done'> => ({
  before: () => {
    first = last = JSON.stringify(get() ?? '');
    since = Date.now();
  },
  done: () => {
    const v = JSON.stringify(get() ?? '');
    if (v !== last) {
      last = v;
      since = Date.now();
    }
    return v !== first && Date.now() - since > 1500;
  },
});

/** The first step of each lesson: the widget added from the + of the layers. */
const add = (label: string, fr: string, en: string, done: () => boolean): Step => ({
  say: { fr: `Cliquez + (Widgets), puis ${fr}.`, en: `Click + (Widgets), then ${en}.` },
  at: () => menuItem(label),
  done,
});

/** A widget of the Library (built with the Builder) placed in the template: its folder. */
const built = (def: string) => layers().find((l) => l.type === 'group' && l.widget?.def === def);

/** The shared widget `name` of the + menu once open, else the +. */
function sharedItem(name: string): Element | null {
  for (const b of document.querySelectorAll<HTMLElement>('.add-menu .add-grid button')) if (b.textContent?.trim() === name && b.getClientRects().length) return b;
  return shown('.menu-wrap > .opx-add');
}

/** Adds the Library's widget `name` (its definition `def`) from the + menu. */
const shared = (name: string, def: string): Step => ({
  say: { fr: `Cliquez + (Widgets), puis ${name} dans les widgets partagés.`, en: `Click + (Widgets), then ${name} in the shared widgets.` },
  at: () => sharedItem(name),
  done: () => !!built(def),
});

/** A widget of the Library is made of bricks: Edit the widget opens them in the Builder. */
const edit: Step = {
  say: { fr: 'Modifier le widget : ses briques s’ouvrent dans le Builder.', en: 'Edit the widget: its bricks open in the Builder.' },
  at: () => seen(shown('.wk-wbar .btn')),
  done: 'next',
};

const clockL = () => W('clock', (l) => l.mode === 'time');
const timeL = () => W('clock', (l) => l.mode !== 'time');

export const lessons: Lesson[] = [
  {
    id: 'designer.widgets.clock',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Horloge et chrono', en: 'Clock and stopwatch' },
    setup: { kind: 'designer' },
    steps: [
      add('Clock', 'Horloge', 'Clock', () => !!clockL()),
      {
        say: { fr: 'Préréglage : choisissez HH:mm:ss pour voir les secondes.', en: 'Preset: choose HH:mm:ss to show the seconds.' },
        at: rowOf('Clock', 'Preset'),
        done: () => clockL()?.format === 'HH:mm:ss',
      },
      add('Time', 'Temps', 'Time', () => !!timeL()),
      {
        say: { fr: 'Mode : Chronomètre.', en: 'Mode: Stopwatch.' },
        at: rowOf('widget|Time', 'Mode'),
        done: () => timeL()?.timerMode === 'stopwatch',
      },
      {
        say: { fr: '▶ Lire : le chrono démarre.', en: '▶ Play: the stopwatch starts.' },
        at: mainButton,
        done: () => {
          const s = stateOf(timeL());
          return !!s && s.startedAt != null && s.pausedAt == null;
        },
      },
    ],
  },
  {
    id: 'designer.widgets.countdown',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Compte à rebours', en: 'Countdown' },
    setup: { kind: 'designer' },
    steps: [
      add('Time', 'Temps', 'Time', () => timeL()?.timerMode === 'countdown'),
      {
        say: { fr: 'Durée : tapez 1:00, puis Entrée.', en: 'Duration: type 1:00, then Enter.' },
        at: tryRow('Duration'),
        done: () => timeL()?.cdDuration === 60000,
      },
      {
        say: { fr: '▶ Lire : le compte à rebours démarre.', en: '▶ Play: the countdown starts.' },
        at: mainButton,
        done: () => {
          const s = stateOf(timeL());
          return !!s && s.startedAt != null && s.pausedAt == null;
        },
      },
      {
        say: { fr: '+10 s : ajoutez du temps.', en: '+10 s: add some time.' },
        at: () => tryButton('+'),
        done: () => Number(stateOf(timeL())?.adj ?? 0) !== 0,
      },
    ],
  },
  {
    id: 'designer.widgets.scoreboard',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Tableau des scores', en: 'Scoreboard' },
    setup: { kind: 'designer' },
    steps: [
      add('Scoreboard', 'Tableau des scores', 'Scoreboard', () => !!W('scoreboard')),
      {
        say: { fr: 'Sport : choisissez Basket-ball.', en: 'Sport: choose Basketball.' },
        at: rowOf('Sport', 'Preset'),
        done: () => W('scoreboard')?.preset === 'basketball',
      },
      {
        say: { fr: 'Cliquez un +3 : l’équipe marque.', en: 'Click a +3: the team scores.' },
        at: () => seen(shown('.pp-try .cc-team .cc-sq.txt')),
        done: () => ((stateOf(W('scoreboard'))?.teams as { score?: number }[] | undefined) ?? []).some((x) => (x?.score ?? 0) > 0),
      },
      {
        say: { fr: '▶ Lire : le chrono du match démarre.', en: '▶ Play: the match clock starts.' },
        at: mainButton,
        done: () => !!(stateOf(W('scoreboard'))?.clock as { running?: boolean } | undefined)?.running,
      },
    ],
  },
  {
    id: 'designer.widgets.table',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Tableau', en: 'Table' },
    setup: { kind: 'designer' },
    steps: [
      add('Table', 'Tableau', 'Table', () => !!W('table')),
      {
        say: { fr: 'Cliquez Modifier le tableau.', en: 'Click Edit the table.' },
        at: '.te-edit',
        done: () => !!shown('.te-full'),
      },
      {
        say: { fr: 'Tous ses réglages sont ici. Cliquez Terminé.', en: 'All its settings are here. Click Done.' },
        at: '.te-full .cv-head .btn.primary',
        done: () => !shown('.te-full'),
      },
      {
        say: { fr: 'Ligne en surbrillance : choisissez une ligne.', en: 'Highlighted row: choose a row.' },
        at: tryRow('cc|Highlighted row'),
        done: () => !!W('table')?.hlKey,
      },
    ],
  },
  {
    id: 'designer.widgets.ticker',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Bandeau défilant', en: 'Ticker' },
    setup: { kind: 'designer' },
    steps: [
      shared('Ticker', 'ticker'),
      {
        say: { fr: 'Infos : une ligne par info, avec sa catégorie. Elles défilent.', en: 'Infos: a row per item, with its category. They go by.' },
        at: () => seen(shown('.pp-try')),
        done: 'next',
      },
      edit,
    ],
  },
  {
    id: 'designer.widgets.credits',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Générique', en: 'Credits' },
    setup: { kind: 'designer' },
    steps: [
      shared('Générique', 'credits'),
      {
        say: { fr: 'Lignes : un titre, un nom et son rôle, un logo ou un espace par ligne. Elles montent.', en: 'Lines: a title, a name and its role, a logo or a space per row. They roll up.' },
        at: () => seen(shown('.pp-try')),
        done: 'next',
      },
      edit,
    ],
  },
  {
    id: 'designer.widgets.typewriter',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Machine à écrire', en: 'Typewriter' },
    setup: { kind: 'designer' },
    steps: [
      add('Typewriter', 'Machine à écrire', 'Typewriter', () => !!W('typewriter')),
      {
        say: { fr: 'Textes : tapez votre phrase.', en: 'Texts: type your sentence.' },
        at: () => inSection('Texts', '.wk-content'),
        ...typed(() => W('typewriter')?.text),
      },
      {
        say: { fr: '▶ Lire : elle s’écrit lettre par lettre.', en: '▶ Play: it types itself letter by letter.' },
        at: mainButton,
        ...acted(() => W('typewriter')),
      },
      {
        say: { fr: 'Vitesse : glissez le curseur.', en: 'Speed: drag the slider.' },
        at: tryRow('Speed'),
        done: () => (W('typewriter')?.speed ?? 32) !== 32,
      },
    ],
  },
  {
    id: 'designer.widgets.progress',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Barre de progression', en: 'Progress bar' },
    setup: { kind: 'designer' },
    steps: [
      add('Progress bar', 'Barre de progression', 'Progress bar', () => !!W('progress')),
      {
        say: { fr: 'Valeur : tapez 30.', en: 'Value: type 30.' },
        at: rowOf('Value', 'Value'),
        ...typed(() => W('progress')?.value),
      },
      {
        say: { fr: 'Forme : Anneau.', en: 'Shape: Ring.' },
        at: rowOf('Shape', 'Shape'),
        done: () => W('progress')?.shape === 'ring',
      },
      {
        say: { fr: '+ 5 : la barre avance.', en: '+ 5: the bar moves on.' },
        at: () => tryButton('+'),
        ...acted(() => W('progress')),
      },
    ],
  },
  {
    id: 'designer.widgets.chart',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Graphiques', en: 'Charts' },
    setup: { kind: 'designer' },
    steps: [
      add('Chart', 'Graphique', 'Chart', () => !!W('chart')),
      {
        say: { fr: 'Graphique › Type : Lignes.', en: 'Chart › Type: Lines.' },
        at: rowOf('Chart', 'Type'),
        done: () => W('chart')?.chartType === 'lines',
      },
      {
        say: { fr: 'Révélation : Par série.', en: 'Reveal: By series.' },
        at: tryRow('Reveal'),
        done: () => W('chart')?.reveal === 'series',
      },
      {
        say: { fr: '⏭ Suivante : une série de plus apparaît.', en: '⏭ Next: one more series shows.' },
        at: () => tryButton(tc('cc', 'Next')),
        ...acted(() => W('chart')),
      },
    ],
  },
  {
    id: 'designer.widgets.map',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Carte', en: 'Map' },
    setup: { kind: 'designer' },
    steps: [
      add('Map', 'Carte', 'Map', () => !!W('map')),
      {
        say: { fr: 'Calques : allumez les zones.', en: 'Layers: turn the zones on.' },
        at: () => tryButton(tc('cc', 'Zones')),
        done: () => !!(W('map')?.layers as { zones?: boolean } | undefined)?.zones,
      },
      {
        say: { fr: 'Mettre en avant : choisissez une région.', en: 'Put forward: choose a region.' },
        at: tryRow('Put forward'),
        done: () => !!W('map')?.hlZone,
      },
      {
        say: { fr: 'Aller à : tapez Lyon, puis Entrée.', en: 'Go to: type Lyon, then Enter.' },
        at: tryRow('cc|Go to'),
        done: () => !!stateOf(W('map'))?.goto,
      },
    ],
  },
  {
    id: 'designer.widgets.qrcode',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'QR code', en: 'QR code' },
    setup: { kind: 'designer' },
    steps: [
      add('QR code', 'QR code', 'QR code', () => !!W('qrCode')),
      {
        say: { fr: 'Remplacez https://example.com par votre adresse.', en: 'Replace https://example.com with your address.' },
        at: () => inSection('Content', '.wk-item'),
        ...typed(() => W('qrCode')?.data),
      },
      {
        say: { fr: '+ Adresse, puis tapez une 2e adresse.', en: '+ Address, then type a 2nd address.' },
        at: () => inSection('Content', ((W('qrCode')?.addresses as unknown[] | undefined)?.length ?? 0) >= 2 ? '.wk-item:nth-child(2) input[placeholder^="https"]' : '.wk-add'),
        // The 2nd address typed (more than the « https:// » it starts with).
        ...typed(() => {
          const a = W('qrCode')?.addresses as { url?: string }[] | undefined;
          const url = a?.[1]?.url ?? '';
          return url.length > 'https://'.length ? url : '';
        }),
      },
      {
        say: { fr: '⏭ Suivante : le code passe à la 2e adresse.', en: '⏭ Next: the code goes to the 2nd address.' },
        at: () => tryButton(tc('cc', 'Next')),
        done: () => stateOf(W('qrCode'))?.addr === 1,
      },
    ],
  },
  {
    id: 'designer.widgets.web',
    cat: 'designer',
    chapter: 'widgets',
    title: { fr: 'Page web', en: 'Web page' },
    setup: { kind: 'designer' },
    steps: [
      add('Iframe', 'Iframe', 'Iframe', () => !!W('web')),
      {
        say: { fr: 'Adresse : tapez celle d’une page web.', en: 'Address: type a web page’s address.' },
        at: rowOf('Page', 'Address'),
        ...typed(() => W('web')?.url),
      },
      {
        say: { fr: '⟳ Actualiser : la page est rechargée.', en: '⟳ Refresh: the page loads again.' },
        at: () => tryButton(tc('cc', 'Refresh')),
        ...acted(() => W('web')),
      },
    ],
  },
];
