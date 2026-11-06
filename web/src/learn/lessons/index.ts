import type { Lesson } from '../types';
import { CHAPTERS } from '../chapters';
import { adminLessons } from './admin';
import { designerLessons } from './designer';
import { operatorLessons } from './operator';

/** Every lesson, in the order of the parts and their chapters. */
export const LESSONS: Lesson[] = (() => {
  const all = [...adminLessons, ...designerLessons, ...operatorLessons];
  const rank = (l: Lesson) => CHAPTERS[l.cat].findIndex((c) => c.id === l.chapter);
  const cats = ['admin', 'designer', 'operator'];
  return all.map((l, i) => ({ l, i })).sort((a, b) => cats.indexOf(a.l.cat) - cats.indexOf(b.l.cat) || rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
})();
