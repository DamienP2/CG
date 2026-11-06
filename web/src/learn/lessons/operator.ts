import type { Lesson } from '../types';
import { lessons as start } from './operator/start';
import { lessons as air } from './operator/air';
import { lessons as values } from './operator/values';
import { lessons as playlists } from './operator/playlists';
import { lessons as widgets } from './operator/widgets';
import { lessons as room } from './operator/room';

export const operatorLessons: Lesson[] = [...start, ...air, ...values, ...playlists, ...widgets, ...room];
