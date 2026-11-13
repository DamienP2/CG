// The words of a widget's Logic (Builder): what a « Widget variable » does to its variable, what an
// « Animated element » asks its element.
import { t } from '../i18n';

/** The changes of a widget variable. */
export const WVAR_OPS = (): [string, string][] => [
  ['add', t('Add')],
  ['set', t('Give the value')],
  ['toggle', t('Invert')],
  ['next', t('Next value')],
  ['prev', t('Previous value')],
  ['cycle', t('Next value (round)')],
  ['reset', t('Back to the start')],
];

/** What an animated element (a Temps…) is asked. */
export const ELEMENT_OPS = (): [string, string][] => [
  ['toggle', t('Play / Pause')],
  ['start', t('Play it')],
  ['pause', t('Pause')],
  ['reset', t('Reset')],
  ['restart', t('Restart')],
  ['adjust', t('± seconds')],
  ['set', t('Set to')],
];
