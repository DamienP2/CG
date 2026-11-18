import { create } from 'zustand';

/** The Widget Builder's page state shared with the Designer drawing its Graphisme (designer/Designer.tsx autosave). */
export const useBuilderUi = create<{ saving: boolean }>(() => ({ saving: false }));
