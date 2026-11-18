import { create } from 'zustand';

/** Where the widget sits in the picture of « Voir dans ». */
export type PreviewPlace = 'bl' | 'bc' | 'br' | 'tl' | 'tr' | 'c';

/**
 * The Widget Builder's page state shared with the Designer drawing its Graphisme: the draft being
 * saved (designer/Designer.tsx autosave), the 8 px grid, and the picture it is seen in.
 */
export const useBuilderUi = create<{ saving: boolean; grid: boolean; preview: 'none' | 'h' | 'v'; place: PreviewPlace }>(() => ({ saving: false, grid: true, preview: 'none', place: 'bl' }));

/** The grid's step, in pixels of the widget. */
export const GRID = 8;
