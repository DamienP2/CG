// Progress bar: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/progress.rs; actions in crates/cg-core/src/wid/progress.rs.
import { SlidersHorizontal } from 'lucide-react';
import { defineWidget } from './kit';

/** Settings of the layer (flattened into it; every field optional: older projects lack them). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Config {}

/** What the operator changes on air (mirrors `State` in the Rust module). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface State {}

export default defineWidget({
  id: 'progress',
  type: 'progress',
  label: 'Progress bar',
  group: 'Data',
  icon: SlidersHorizontal,
  create: () => ({}),
});
