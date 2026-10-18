// Ticker: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/ticker.rs; actions in crates/cg-core/src/wid/ticker.rs.
import { MoveHorizontal } from 'lucide-react';
import { defineWidget } from './kit';

/** Settings of the layer (flattened into it; every field optional: older projects lack them). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Config {}

/** What the operator changes on air (mirrors `State` in the Rust module). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface State {}

export default defineWidget({
  id: 'ticker',
  type: 'ticker',
  label: 'Ticker',
  group: 'Data',
  icon: MoveHorizontal,
  create: () => ({}),
});
