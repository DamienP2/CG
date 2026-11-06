import type { Lesson } from '../types';
import { lessons as start } from './admin/start';
import { lessons as access } from './admin/access';
import { lessons as control } from './admin/control';
import { lessons as video } from './admin/video';
import { lessons as integrations } from './admin/integrations';
import { lessons as supervision } from './admin/supervision';

export const adminLessons: Lesson[] = [...start, ...access, ...control, ...video, ...integrations, ...supervision];
