// Registry of the spec widgets (one file each; see kit.tsx).
import type { LayerType } from '../engine/types';
import type { WidgetDef } from './kit';
import quad from './quad';
import polygon from './polygon';
import ellipse from './ellipse';
import text from './text';
import image from './image';
import pen from './pen';
import timer from './timer';
import table from './table';
import ticker from './ticker';
import credits from './credits';
import typewriter from './typewriter';
import counter from './counter';
import progress from './progress';
import chart from './chart';
import map from './map';
import qrcode from './qrcode';
import web from './web';
import scoreboard from './scoreboard';

/** In the order of the spec. */
export const WIDGET_LIST: WidgetDef[] = [quad, polygon, ellipse, text, image, pen, timer, table, ticker, credits, typewriter, counter, progress, chart, map, qrcode, scoreboard, web] as unknown as WidgetDef[];

/** By layer type. */
export const WIDGETS: Partial<Record<LayerType, WidgetDef>> = Object.fromEntries(WIDGET_LIST.map((w) => [w.type, w]));

export const widgetOf = (type: LayerType): WidgetDef | undefined => WIDGETS[type];
