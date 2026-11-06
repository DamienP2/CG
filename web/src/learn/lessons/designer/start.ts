import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { designTemplates } from '../../../engine/drafts';
import { useZoneEdit } from '../../../designer/ZoneEditor';
import { project, shown, template, withText } from '../../probe';

/** An input of a dialog shown (its value, '' when none). */
const value = (sel: string) => (shown(sel) as HTMLInputElement | null)?.value ?? '';
/** The name the New template dialog offered. */
let offered = '';
/** The zones of the zone editor when the step began; the template's zone. */
let zonesBefore = 0;
let zoneBefore = '';
/** The first template of the project. */
const firstTemplate = () => {
  const p = project();
  return p ? designTemplates(p)[0] : undefined;
};

/** designer › start. */
export const lessons: Lesson[] = [
  {
    id: 'designer.start.new-project',
    cat: 'designer',
    chapter: 'start',
    title: { fr: 'Créer un projet', en: 'Create a project' },
    setup: { kind: 'page', path: '/projects' },
    steps: [
      {
        say: { fr: 'Un projet réunit les modèles d’une émission. Cliquez Nouveau projet.', en: 'A project holds the templates of a show. Click New project.' },
        at: () => withText('.settings-head .btn.primary', t('New project')),
        done: () => !!withText('.modal h2', t('New project')),
      },
      {
        say: { fr: 'Donnez-lui un nom.', en: 'Give it a name.' },
        at: '.modal input',
        done: () => value('.modal input').trim().length > 0,
      },
      {
        say: { fr: 'Choisissez son format : la taille de l’image et les images par seconde.', en: 'Choose its format: the picture size and the frames per second.' },
        at: '.modal .pjp-format',
        done: { click: '.modal .pjp-format button' },
      },
      {
        say: { fr: 'Créer l’ouvrirait. Ici, on s’exerce : cliquez Annuler.', en: 'Create would open it. Here we practise: click Cancel.' },
        at: '.modal footer .btn:not(.primary)',
        done: () => !shown('.modal'),
      },
    ],
  },
  {
    id: 'designer.start.example',
    cat: 'designer',
    chapter: 'start',
    title: { fr: 'Partir d’un exemple', en: 'Start from an example' },
    setup: { kind: 'page', path: '/projects' },
    steps: [
      {
        say: { fr: 'Des habillages complets, prêts à l’antenne : cliquez Exemples.', en: 'Complete graphics packages, ready for air: click Examples.' },
        at: () => withText('.settings-head .btn', t('Examples')),
        done: () => !!shown('.example-bank'),
      },
      {
        say: { fr: 'Faites défiler : journal, sport, météo, élections…', en: 'Scroll: news, sport, weather, elections…' },
        at: '.example-bank .example-grid',
        done: () => (shown('.example-bank .example-grid')?.scrollTop ?? 0) > 150 || (shown('.example-bank')?.scrollTop ?? 0) > 150,
      },
      {
        say: { fr: 'Ajouter à mes projets en fait une copie à vous. Pour l’instant, fermez.', en: 'Add to my projects makes a copy of your own. For now, close.' },
        at: '.example-bank header .icon-btn',
        done: () => !shown('.example-bank'),
      },
    ],
  },
  {
    id: 'designer.start.add-template',
    cat: 'designer',
    chapter: 'start',
    title: { fr: 'Ajouter un modèle', en: 'Add a template' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Un modèle = un graphique (synthé, score…). Cliquez le + de Modèles.', en: 'A template = one graphic (lower third, score…). Click the + of Templates.' },
        at: '.template-list header .opx-add',
        done: () => !!shown('.new-tpl'),
      },
      {
        say: { fr: 'Nommez-le, par exemple « Synthé ».', en: 'Name it, for example “Lower third”.' },
        at: '.new-tpl input',
        before: () => void (offered = ''),
        done: () => {
          const v = value('.new-tpl input').trim();
          if (!offered) offered = v;
          return !!v && v !== offered;
        },
      },
      {
        say: { fr: 'Cliquez Créer.', en: 'Click Create.' },
        at: '.new-tpl-new .btn.primary',
        done: () => {
          const p = project();
          return !!p && designTemplates(p).length >= 2;
        },
      },
      {
        say: { fr: 'Le voici, ouvert. Cliquez Modèle 1 pour revenir au premier.', en: 'Here it is, open. Click Template 1 to go back to the first one.' },
        at: () => document.querySelector('.template-list .template-item'),
        done: () => !!template() && template()?.id === firstTemplate()?.id,
      },
    ],
  },
  {
    id: 'designer.start.zones',
    cat: 'designer',
    chapter: 'start',
    title: { fr: 'Zones de l’image', en: 'Zones of the picture' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Une zone : la place d’un graphique à l’image. Cliquez le réglage de Zone.', en: 'A zone: where a graphic goes in the picture. Click the setting of Zone.' },
        at: '.tpl-zones-edit',
        done: () => !!shown('.zp'),
      },
      {
        say: { fr: 'Cliquez + : une nouvelle zone.', en: 'Click +: a new zone.' },
        at: '.zp-head .icon-btn',
        before: () => void (zonesBefore = useZoneEdit.getState().zones.length),
        done: () => useZoneEdit.getState().zones.length > zonesBefore,
      },
      {
        say: { fr: 'Glissez-la sur le canvas, ou tirez ses poignées.', en: 'Drag it on the canvas, or pull its handles.' },
        at: '.ze-box.on',
        done: () => {
          const s = useZoneEdit.getState();
          const z = s.zones.find((x) => x.id === s.selected);
          return !!z && Object.keys(z.areas ?? {}).length > 0;
        },
      },
      {
        say: { fr: 'Cliquez Terminé.', en: 'Click Done.' },
        at: '.zp-foot .btn.primary',
        done: () => !useZoneEdit.getState().on && (project()?.zones.length ?? 0) > zonesBefore,
      },
      {
        say: { fr: 'Choisissez-la pour ce modèle : il passera là.', en: 'Choose it for this template: it will go there.' },
        at: '.tpl-zones',
        before: () => void (zoneBefore = template()?.zone ?? ''),
        done: () => !!template() && template()?.zone !== zoneBefore,
      },
    ],
  },
  {
    id: 'designer.start.tour',
    cat: 'designer',
    chapter: 'start',
    title: { fr: 'Tour de l’écran Designer', en: 'Tour of the Designer' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'À gauche, les modèles du projet : un modèle = un graphique.', en: 'On the left, the templates of the project: one template = one graphic.' },
        at: '.panel.left',
        done: 'next',
      },
      {
        say: { fr: 'Au centre, le canvas : l’image telle qu’elle passera à l’antenne.', en: 'In the middle, the canvas: the picture as it will go on air.' },
        at: '.stage-holder',
        done: 'next',
      },
      {
        say: { fr: 'En bas, les calques et la timeline : ajoutez des formes, animez-les.', en: 'At the bottom, the layers and the timeline: add shapes, animate them.' },
        at: '.timeline-wrap',
        done: 'next',
      },
      {
        say: { fr: 'À droite, les propriétés de ce qui est choisi : calque ou modèle.', en: 'On the right, the properties of what is chosen: layer or template.' },
        at: '.panel.right',
        done: 'next',
      },
      {
        say: { fr: 'Tout s’enregistre seul. Publier envoie les modèles à l’Opérateur.', en: 'Everything saves by itself. Publish sends the templates to the Operator.' },
        at: '.ux2-publish',
        done: 'next',
      },
    ],
  },
];
