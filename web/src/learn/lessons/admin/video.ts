import type { Lesson, Step } from '../../types';
import { t } from '../../../i18n';
import { onPage, shown, withText } from '../../probe';

/** Unsaved changes on the page (its bar « Discard / Apply »). */
const dirty = () => !!shown('.save-bar.show');
const discardStep: Step = {
  say: { fr: 'Abandonner : rien n’est changé.', en: 'Discard: nothing changes.' },
  at: '.save-bar.show .btn:not(.primary)',
  done: () => !dirty(),
};
/** The « + » of the first format: what it sends to. */
const plusStep: Step = {
  say: { fr: 'Le + d’un format lui ajoute une sortie. Cliquez-le.', en: 'A format’s + adds an output to it. Click it.' },
  at: '.oc-node.picture .oc-plus',
  done: () => !!shown('.oc-add-menu'),
};
/** A choice of the add menu, by its label. */
const choice = (label: string) => withText('.oc-add-menu button', new RegExp(`^\\s*${label}\\s*$`));
/** A tab of the page, open. */
const tabOn = (label: string) => !!withText('.sys-tabs [role=tab][aria-selected=true]', label);

/** admin › video. */
export const lessons: Lesson[] = [
  {
    id: 'admin.video.sdi',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'Ajouter une sortie SDI', en: 'Add an SDI output' },
    setup: { kind: 'page', path: '/outputs' },
    steps: [
      plusStep,
      {
        say: { fr: 'Cliquez SDI.', en: 'Click SDI.' },
        at: () => choice('SDI'),
        done: () => !shown('.oc-add-menu'),
      },
      {
        say: { fr: 'SDI grisé ? Déclarez d’abord la carte dans Matériel vidéo. Sinon, réglez-la à droite.', en: 'SDI greyed? First declare the card in Video hardware. Else, set it on the right.' },
        at: '.oc-inspector',
        done: 'next',
      },
      discardStep,
    ],
  },
  {
    id: 'admin.video.ndi',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'Sortie NDI', en: 'NDI output' },
    setup: { kind: 'page', path: '/outputs' },
    steps: [
      plusStep,
      {
        say: { fr: 'Cliquez NDI.', en: 'Click NDI.' },
        at: () => choice('NDI'),
        done: dirty,
      },
      {
        say: { fr: 'Son nom : la source que voient les logiciels NDI du réseau.', en: 'Its name: the source NDI software sees on the network.' },
        at: '.oc-inspector .set-field input',
        done: 'next',
      },
      discardStep,
    ],
  },
  {
    id: 'admin.video.stream',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'Sortie flux (SRT, RTMP)', en: 'Stream output (SRT, RTMP)' },
    setup: { kind: 'page', path: '/outputs' },
    steps: [
      plusStep,
      {
        say: { fr: 'Cliquez Flux.', en: 'Click Stream.' },
        at: () => choice(t('Stream')),
        done: dirty,
      },
      {
        say: { fr: 'Protocole : cliquez RTMP.', en: 'Protocol: click RTMP.' },
        at: '.oc-inspector .vs-seg',
        done: { click: '.oc-inspector .vs-seg button' },
      },
      {
        say: { fr: 'Collez ici l’adresse et la clé de YouTube ou Twitch.', en: 'Paste YouTube’s or Twitch’s address and key here.' },
        at: '.oc-inspector input[spellcheck="false"]',
        done: 'next',
      },
      discardStep,
    ],
  },
  {
    id: 'admin.video.html5',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'Sortie HTML5', en: 'HTML5 output' },
    setup: { kind: 'page', path: '/outputs' },
    steps: [
      plusStep,
      {
        say: { fr: 'Cliquez HTML5.', en: 'Click HTML5.' },
        at: () => choice('HTML5'),
        done: dirty,
      },
      {
        say: { fr: 'Son adresse : une page transparente, pour OBS, vMix ou un navigateur.', en: 'Its address: a transparent page, for OBS, vMix or a browser.' },
        at: '.oc-inspector .oc-path, .oc-inspector .oc-link',
        done: 'next',
      },
      discardStep,
    ],
  },
  {
    id: 'admin.video.inputs',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'Entrées vidéo', en: 'Video inputs' },
    setup: { kind: 'page', path: '/inputs' },
    steps: [
      {
        say: { fr: 'Une caméra, un flux sous les graphiques. Cliquez Ajouter une entrée.', en: 'A camera, a stream under the graphics. Click Add an input.' },
        at: '.oc-tool',
        done: dirty,
      },
      {
        say: { fr: 'Type : SRT, NDI, SDI… Ouvrez la liste.', en: 'Type: SRT, NDI, SDI… Open the list.' },
        at: () => shown(`.oc-inspector .dd-btn[title="${t('Type')}"]`),
        done: () => !!shown('.dd-list'),
      },
      {
        say: { fr: 'Choisissez un type, ou Échap.', en: 'Choose a type, or Esc.' },
        at: '.dd-list',
        done: () => !shown('.dd-list'),
      },
      discardStep,
    ],
  },
  {
    id: 'admin.video.decklink',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'Cartes DeckLink', en: 'DeckLink cards' },
    setup: { kind: 'page', path: '/system/hardware' },
    steps: [
      {
        say: { fr: 'Cliquez Rechercher : Strata cherche les cartes.', en: 'Click Search: Strata looks for the cards.' },
        at: '.sys-tabrow > .btn',
        done: { click: '.sys-tabrow > .btn' },
      },
      {
        say: { fr: 'Une carte trouvée : Adopter, puis Enregistrer et appliquer.', en: 'A card found: Adopt, then Save & apply.' },
        at: '.fio-found, .fio-card, .fio-empty',
        done: 'next',
      },
      {
        say: { fr: 'Ses sorties se branchent ensuite dans Diffusion. Cliquez Diffusion.', en: 'Its outputs are then wired in Broadcast. Click Broadcast.' },
        at: '.ux1-navgroup > button',
        done: () => !!shown('.ux1-navmenu'),
      },
      {
        say: { fr: 'Sorties, entrées, caméras. Cliquez Flux sorties.', en: 'Outputs, inputs, cameras. Click Output streams.' },
        at: '.ux1-navmenu',
        done: () => onPage(/^\/outputs/),
      },
    ],
  },
  {
    id: 'admin.video.st2110',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'ST 2110 et PTP', en: 'ST 2110 and PTP' },
    setup: { kind: 'page', path: '/system/hardware' },
    steps: [
      {
        say: { fr: 'Cliquez SMPTE ST 2110.', en: 'Click SMPTE ST 2110.' },
        at: () => withText('.sys-tabs [role=tab]', 'ST 2110'),
        done: () => tabOn('ST 2110'),
      },
      {
        say: { fr: 'PTP : l’horloge commune du réseau. Verrouillé, tout est calé.', en: 'PTP: the network’s shared clock. Locked, all is in time.' },
        at: '.fio-ptp',
        done: 'next',
      },
      {
        say: { fr: 'Les flux : chacun en multicast, sur le réseau rouge et le bleu.', en: 'The flows: each one multicast, on the red and the blue network.' },
        at: '.fio-flows',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez + Flux.', en: 'Click + Flow.' },
        at: '.sys-tabrow > .btn',
        done: dirty,
      },
      discardStep,
    ],
  },
  {
    id: 'admin.video.formats',
    cat: 'admin',
    chapter: 'video',
    title: { fr: 'Formats et entrelacé', en: 'Formats and interlaced' },
    setup: { kind: 'page', path: '/outputs' },
    steps: [
      {
        say: { fr: 'Le format du canal : cliquez Format vidéo.', en: 'The channel’s format: click Video format.' },
        at: () => shown(`.oc-inspector .dd-btn[title="${t('Video format')}"]`) ?? shown('.oc-node.program'),
        done: () => !!shown('.dd-list'),
      },
      {
        say: { fr: 'i : entrelacé (1080i 50). p : progressif. Échap : fermer.', en: 'i: interlaced (1080i 50). p: progressive. Esc: close.' },
        at: '.dd-list',
        done: () => !shown('.dd-list'),
      },
      {
        say: { fr: 'Changé ? Abandonner : rien n’est changé.', en: 'Changed? Discard: nothing changes.' },
        at: '.save-bar.show .btn:not(.primary)',
        done: () => !dirty(),
      },
    ],
  },
];
