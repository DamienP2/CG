import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { shown, withText } from '../../probe';

/** Unsaved changes on the page (its bar « Discard / Save »). */
const dirty = () => !!shown('.save-bar.show');
const discard = '.save-bar.show .btn:not(.primary)';
/** A settings card, by its title. */
const card = (title: string) => withText('.set-card', title);
const sso = () => card(t('Sign-in through the company directory (SSO)'));
const https = () => card('HTTPS');
/** The user dialog's Cancel. */
const cancel = '.modal footer .btn:not(.primary)';
/** The user dialog's scopes: its projects, its channels (none for an admin). */
const scopes = () => [...document.querySelectorAll<HTMLElement>('.modal div.set-field')].filter((el) => el.querySelector(':scope > label.check') && el.getClientRects().length);

/** admin › access. */
export const lessons: Lesson[] = [
  {
    id: 'admin.access.new-user',
    cat: 'admin',
    chapter: 'access',
    title: { fr: 'Créer un utilisateur', en: 'Create a user' },
    setup: { kind: 'page', path: '/system/users' },
    steps: [
      {
        say: { fr: 'Cliquez Nouvel utilisateur.', en: 'Click New user.' },
        at: '.settings-head .btn.primary',
        done: () => !!shown('.modal .role-pick'),
      },
      {
        say: { fr: 'Son nom pour se connecter, et un mot de passe (8 caractères ou plus).', en: 'Their sign-in name, and a password (8 characters or more).' },
        at: '.modal .set-grid',
        done: 'next',
      },
      {
        say: { fr: 'Le rôle dit ce qu’il peut faire. Cliquez-en un.', en: 'The role says what they can do. Click one.' },
        at: '.modal .role-pick',
        done: { click: '.modal .role-pick button' },
      },
      {
        say: { fr: 'Ici, Annuler : rien n’est créé.', en: 'Here, Cancel: nothing is created.' },
        at: cancel,
        done: () => !shown('.modal .role-pick'),
      },
    ],
  },
  {
    id: 'admin.access.roles',
    cat: 'admin',
    chapter: 'access',
    title: { fr: 'Rôles et projets permis', en: 'Roles and allowed projects' },
    setup: { kind: 'page', path: '/system/users' },
    steps: [
      {
        say: { fr: 'Quatre rôles. Survolez-en un pour ses droits, puis cliquez Opérateurs.', en: 'Four roles. Hover one for its rights, then click Operators.' },
        at: '.asr-chips',
        done: () => !!withText('.asr-chip.on', t('Operators')),
      },
      {
        say: { fr: 'Ouvrez un opérateur (ou Nouvel utilisateur).', en: 'Open an operator (or New user).' },
        at: '.user-card, .user-new',
        done: () => scopes().length > 0,
      },
      {
        say: { fr: 'Projets : désactivez « Tous » pour choisir ceux qu’il ouvre.', en: 'Projects: turn off “All” to choose the ones they open.' },
        at: () => scopes()[0],
        done: () => !!shown('.modal .scope-list'),
      },
      {
        say: { fr: 'Annuler : rien n’est changé.', en: 'Cancel: nothing changes.' },
        at: cancel,
        done: () => !shown('.modal .role-pick'),
      },
    ],
  },
  {
    id: 'admin.access.sso',
    cat: 'admin',
    chapter: 'access',
    title: { fr: 'Connexion SSO', en: 'SSO sign-in' },
    setup: { kind: 'page', path: '/system/security' },
    steps: [
      {
        say: { fr: 'Connexion par l’annuaire (Entra, Google…) : activez-la pour voir les réglages.', en: 'Sign-in through the directory (Entra, Google…): turn it on to see the settings.' },
        at: () => sso()?.querySelector('header .check'),
        done: () => !!shown('.sec-url'),
      },
      {
        say: { fr: 'Fournisseur, émetteur, ID client, secret : donnés par votre annuaire.', en: 'Provider, issuer, client ID, secret: given by your directory.' },
        at: () => sso()?.querySelector('.set-grid'),
        done: 'next',
      },
      {
        say: { fr: 'Les groupes de l’annuaire donnent les rôles.', en: 'The directory’s groups give the roles.' },
        at: '.sec-groups',
        done: 'next',
      },
      {
        say: { fr: 'Abandonner : rien n’est changé.', en: 'Discard: nothing changes.' },
        at: discard,
        done: () => !dirty(),
      },
    ],
  },
  {
    id: 'admin.access.api-keys',
    cat: 'admin',
    chapter: 'access',
    title: { fr: 'Clés API', en: 'API keys' },
    setup: { kind: 'page', path: '/system/keys' },
    steps: [
      {
        say: { fr: 'Une clé laisse un logiciel (Companion, script) agir sans mot de passe.', en: 'A key lets software (Companion, a script) act without a password.' },
        at: '.key-form',
        done: 'next',
      },
      {
        say: { fr: 'Elle agit en tant que cet utilisateur. Ouvrez la liste.', en: 'It acts as this user. Open the list.' },
        at: '.key-owner',
        done: () => !!shown('.dd-list'),
      },
      {
        say: { fr: 'Donnez-lui le moins de droits possible. Échap : fermer.', en: 'Give it as few rights as possible. Esc: close.' },
        at: '.dd-list',
        done: () => !shown('.dd-list'),
      },
      {
        say: { fr: 'Le secret ne s’affiche qu’une fois. Révoquer coupe la clé.', en: 'The secret shows only once. Revoke cuts the key off.' },
        at: '.key-grid, .empty',
        done: 'next',
      },
    ],
  },
  {
    id: 'admin.access.https',
    cat: 'admin',
    chapter: 'access',
    title: { fr: 'HTTPS et certificat', en: 'HTTPS and certificate' },
    setup: { kind: 'page', path: '/system/security' },
    steps: [
      {
        say: { fr: 'Certificat : cliquez Auto-signé.', en: 'Certificate: click Self-signed.' },
        at: () => https()?.querySelector('.segmented'),
        done: () => !!shown('.sec-certs .set-field'),
      },
      {
        say: { fr: 'Auto-signé : le navigateur avertit. Mon certificat : le vôtre, sans alerte.', en: 'Self-signed: the browser warns. My certificate: your own, no warning.' },
        at: '.sec-certs .set-field',
        done: 'next',
      },
      {
        say: { fr: 'HTTP : renvoyé vers HTTPS, ou laissé ouvert.', en: 'HTTP: sent to HTTPS, or left open.' },
        at: () => https()?.querySelectorAll('.segmented')[1],
        done: 'next',
      },
      {
        say: { fr: 'Abandonner : rien n’est changé.', en: 'Discard: nothing changes.' },
        at: discard,
        done: () => !dirty(),
      },
    ],
  },
];
