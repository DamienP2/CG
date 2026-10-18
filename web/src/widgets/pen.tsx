// Pen: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/pen.rs; actions in crates/cg-core/src/wid/pen.rs.
import { PenTool } from 'lucide-react';
import { defineWidget } from './kit';

/** Settings of the layer (flattened into it; every field optional: older projects lack them). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Config {}

/** What the operator changes on air (mirrors `State` in the Rust module). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface State {}

export default defineWidget({
  id: 'pen',
  type: 'pen',
  label: 'Pen',
  group: 'Shapes & tools',
  icon: PenTool,
  create: () => ({ props: { width: 600, height: 400 } }),
});
