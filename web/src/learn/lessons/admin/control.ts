import type { Lesson, Text } from '../../types';
import { t } from '../../../i18n';
import { onPage, shown, withText } from '../../probe';

/** A settings card, by its title. */
const card = (title: string) => withText('.set-card', title);
/** This computer is not a production station yet: its « Declare » button. */
const declare = () => shown('.st-here .btn.primary');
const rename = () => shown(`.update-row .icon-btn[title="${t('Rename')}"]`);
/** One text or the other, chosen when shown. */
const either = (first: () => boolean, a: Text, b: Text): Text => ({
  get fr() {
    return first() ? a.fr : b.fr;
  },
  get en() {
    return first() ? a.en : b.en;
  },
});
const dialog = () => shown('.modal.dialog');
const cancel = '.modal.dialog footer .btn:not(.primary)';

/** admin › control. */
export const lessons: Lesson[] = [
  {
    id: 'admin.control.stations',
    cat: 'admin',
    chapter: 'control',
    title: { fr: 'Postes de production', en: 'Production stations' },
    setup: { kind: 'page', path: '/system/stations' },
    steps: [
      {
        say: { fr: 'Seul un poste de production passe à l’antenne. Ailleurs, l’Opérateur simule.', en: 'Only a production station goes on air. Elsewhere, the Operator simulates.' },
        at: () => card(t('This computer')),
        done: 'next',
      },
      {
        say: { fr: 'Les postes déclarés, et quand ils ont été vus.', en: 'The declared stations, and when they were seen.' },
        at: () => card(t('Production stations')),
        done: 'next',
      },
      {
        say: either(
          () => !!declare(),
          { fr: 'Cliquez Déclarer comme poste de production.', en: 'Click Declare as production station.' },
          { fr: 'Cliquez le crayon d’un poste : Renommer.', en: 'Click a station’s pencil: Rename.' },
        ),
        at: () => declare() ?? rename(),
        done: () => !!dialog(),
      },
      {
        say: { fr: 'Annuler : rien n’est changé.', en: 'Cancel: nothing changes.' },
        at: cancel,
        done: () => !dialog(),
      },
    ],
  },
  {
    id: 'admin.control.simulate',
    cat: 'admin',
    chapter: 'control',
    title: { fr: 'Simuler un poste', en: 'Simulate a station' },
    setup: { kind: 'page', path: '/system/stations' },
    steps: [
      {
        say: { fr: 'Ce poste n’est pas déclaré ? Son Opérateur simule : rien ne part à l’antenne.', en: 'This computer not declared? Its Operator simulates: nothing goes on air.' },
        at: () => card(t('This computer')),
        done: 'next',
      },
      {
        say: { fr: 'Le × d’un poste le retire : il simule alors.', en: 'A station’s × removes it: it then simulates.' },
        at: () => shown(`.update-row .icon-btn[title="${t('Remove')}"]`) ?? card(t('Production stations')),
        done: 'next',
      },
      {
        say: { fr: 'Pour répéter sans risque : les leçons Opérateur. Cliquez ?.', en: 'To rehearse safely: the Operator lessons. Click ?.' },
        at: '.learn-help',
        done: () => onPage(/^\/learn/),
      },
    ],
  },
  {
    id: 'admin.control.operators',
    cat: 'admin',
    chapter: 'control',
    title: { fr: 'Plusieurs opérateurs', en: 'Several operators' },
    setup: { kind: 'page', path: '/system/users' },
    steps: [
      {
        say: { fr: 'Un compte par opérateur. Cliquez Opérateurs.', en: 'One account per operator. Click Operators.' },
        at: () => withText('.asr-chip', t('Operators')),
        done: () => !!withText('.asr-chip.on', t('Operators')),
      },
      {
        say: { fr: 'Ouvrez un opérateur (ou Nouvel utilisateur).', en: 'Open an operator (or New user).' },
        at: '.user-card, .user-new',
        done: () => !!shown('.modal .role-pick'),
      },
      {
        say: { fr: 'Canaux : ceux qu’il pilote. Chacun les siens, sans se gêner.', en: 'Channels: the ones they drive. Each their own, no clash.' },
        at: () => [...document.querySelectorAll<HTMLElement>('.modal div.set-field')].filter((el) => el.querySelector(':scope > label.check') && el.getClientRects().length)[1] ?? shown('.modal .role-pick'),
        done: 'next',
      },
      {
        say: { fr: 'Annuler : rien n’est changé.', en: 'Cancel: nothing changes.' },
        at: '.modal footer .btn:not(.primary)',
        done: () => !shown('.modal .role-pick'),
      },
      {
        say: { fr: 'Journal d’antenne : qui a fait quoi. Cliquez-le.', en: 'As-run log: who did what. Click it.' },
        at: () => withText('.sys-page .lib-nav-item', t('As-run log')),
        done: () => onPage(/^\/system\/asrun/),
      },
    ],
  },
];
