// Text: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/text.rs; actions in crates/cg-core/src/wid/text.rs.
import { Type } from 'lucide-react';
import { defineWidget } from './kit';

/** Settings of the layer (flattened into it; every field optional: older projects lack them). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Config {}

/** What the operator changes on air (mirrors `State` in the Rust module). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface State {}

export default defineWidget({
  id: 'text',
  type: 'text',
  label: 'Text',
  group: 'Shapes & tools',
  icon: Type,
  create: () => ({}),
});
