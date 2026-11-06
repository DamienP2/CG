import type { Lesson } from '../types';
import { lessons as start } from './designer/start';
import { lessons as draw } from './designer/draw';
import { lessons as text } from './designer/text';
import { lessons as media } from './designer/media';
import { lessons as animate } from './designer/animate';
import { lessons as widgets } from './designer/widgets';
import { lessons as data } from './designer/data';
import { lessons as logic } from './designer/logic';
import { lessons as air } from './designer/air';

export const designerLessons: Lesson[] = [...start, ...draw, ...text, ...media, ...animate, ...widgets, ...data, ...logic, ...air];
