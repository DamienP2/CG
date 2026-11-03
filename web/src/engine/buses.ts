import type { PlayoutItem } from './types';

/*
 * The outputs of a channel (the antenne, an « Écran plateau »…) each have their
 * zones: a graphic is kept at `bus * BUS_STRIDE + zone layer`, the antenne
 * being bus 0 (cg_core::playout::BUS_STRIDE).
 */
export const BUS_STRIDE = 10_000;

/** The output of a key of the channel's layers. */
export const busOf = (key: number | string) => Math.floor(Number(key) / BUS_STRIDE);

/** The zone layer of a key of the channel's layers. */
export const zoneLayer = (key: number | string) => Number(key) % BUS_STRIDE;

/** The graphics of one output, keyed by their zone layer (what its pictures draw). */
export function busItems(layers: Record<string, PlayoutItem>, bus = 0): [string, PlayoutItem][] {
  return Object.entries(layers)
    .filter(([k]) => busOf(k) === bus)
    .map(([k, v]): [string, PlayoutItem] => [String(zoneLayer(k)), v]);
}
