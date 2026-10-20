import {
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  PenLine,
  Plus,
  Repeat,
  Rows3,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { pipeline, useData, type Stage } from "../data/dataStore";
import { Cell } from "../designer/DataCanvas";
import { holdFrame } from "../engine/evaluate";
import {
  columnKey,
  linesKey,
  oneKey,
  rowKey,
  type Command,
  type Data,
  type DataSet,
  type PlayoutItem,
  type RowChange,
  type Template,
} from "../engine/types";
import { useApp } from "../store";

/*
 * The data sets of a graphic in the Operator's Data block: its rows, the
 * one on air (AIR, red) and the one coming next (NEXT, green, shown in
 * Preview). Click a row: it is next; double-click: on air at once. Auto and
 * Loop run on the server (the time counts once the graphic holds on air)
 * and only stop when the operator (or the API) stops them. Values set by
 * hand override the data for some seconds, until a trigger or until
 * removed; rows added by hand stay until removed.
 */

const autoKey = (k: string) => `${k}__auto`;
const loopKey = (k: string) => `${k}__loop`;
const shownKey = (k: string) => `${k}__shown`;
const addedKey = (k: string) => `${k}__added`;
export const manualKey = (k: string) => `${k}__manual`;

interface Added {
  at?: number | null;
  cells: Record<string, string>;
}
const parseAdded = (v?: string): Added[] => {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/** The rows of a data set now (its last table), refreshed when the source changes. */
export function useDatasetRows(
  ds: DataSet,
  data: Data,
): Stage | null | undefined {
  const version = useData((s) => s.versions[ds.source] ?? 0);
  const used =
    JSON.stringify(ds.steps ?? [])
      .match(/\{(\w+)\}/g)
      ?.map((m) => m.slice(1, -1)) ?? [];
  const sub = Object.fromEntries(used.map((k) => [k, data[k] ?? ""]));
  const key = JSON.stringify([ds.source, ds.list, ds.steps, sub, version]);
  const [stage, setStage] = useState<Stage | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void pipeline(ds.source, ds.list, ds.steps ?? [], sub).then(
      (r) => live && setStage(r ? r.stages[r.stages.length - 1] : null),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return stage;
}

/** The table with the rows added by hand (as the server does), and which entry each row is. */
function withAdded(
  t: Stage,
  added: Added[],
): { columns: string[]; rows: string[][]; entry: (number | null)[] } {
  const columns = [...t.columns];
  const rows = t.rows.map((r) => [...r]);
  const entry: (number | null)[] = rows.map(() => null);
  added.forEach((a, n) => {
    for (const c of Object.keys(a.cells))
      if (!columns.includes(c)) {
        columns.push(c);
        rows.forEach((r) => r.push(""));
      }
    const at = a.at
      ? Math.min(Math.max(0, a.at - 1), rows.length)
      : rows.length;
    rows.splice(
      at,
      0,
      columns.map((c) => a.cells[c] ?? ""),
    );
    entry.splice(at, 0, n);
  });
  return { columns, rows, entry };
}

const rowOf = (data: Data | undefined, ds: DataSet) =>
  Math.max(1, parseInt(data?.[rowKey(ds.key)] ?? "1", 10) || 1);
/** What a graphic on air shows, or comes back with (out › in). */
export const shownData = (p: PlayoutItem) =>
  p.next && p.next.rundownId === p.rundownId ? p.next.data : p.data;

export function DataSetPanel({
  ds,
  template,
  draft,
  onAir,
  operate,
  zone,
  fps,
  onDraft,
  command,
  keys,
}: {
  ds: DataSet;
  template: Template;
  /** The item's data: its row is the next one. */
  draft: Data;
  /** The item on air, if it is. */
  onAir: PlayoutItem | undefined;
  operate: boolean;
  zone: string | undefined;
  fps: number;
  onDraft: (patch: Data) => void;
  command: (c: Command) => void;
  /** ← → drive this one. */
  keys?: boolean;
}) {
  const t = useDatasetRows(ds, draft);
  const live = onAir ? shownData(onAir) : undefined;
  // Auto, loop and the added rows: as on air, else as kept in the item.
  const conf = live ?? draft;
  const added = parseAdded(conf[addedKey(ds.key)]);
  const table = t ? withAdded(t, added) : null;
  const total = table?.rows.length ?? 0;
  const air = live ? Math.min(rowOf(live, ds), Math.max(total, 1)) : null;
  const next = Math.min(rowOf(draft, ds), Math.max(total, 1));
  const auto = parseFloat(conf[autoKey(ds.key)] ?? "") || 0;
  const loop = conf[loopKey(ds.key)] === "1";
  // A Text showing the rows: all of them, or only the current one.
  const usesLines = template.layers.some(
    (l) => l.type === "text" && l.text.includes(`{{${linesKey(ds.key)}}}`),
  );
  const one = conf[oneKey(ds.key)] === "1";
  const change = (conf[changeKey(ds.key)] || ds.change || "outIn") as RowChange;
  const [every, setEvery] = useState(() => auto || 8);
  const after = (row: number) => (row < total ? row + 1 : loop ? 1 : row);

  /** Changes kept in the item and, on air, sent to the graphic. */
  const set = (patch: Data) => {
    onDraft(patch);
    if (onAir) command({ action: "update", zone, data: patch });
  };
  const show = (row: number) => {
    onDraft({ [rowKey(ds.key)]: String(row) });
    if (onAir) command({ action: "row", dataset: ds.key, row, zone });
  };
  // On air on the NEXT row: the one after is next.
  useEffect(() => {
    if (air !== null && air === next && total > 1)
      onDraft({ [rowKey(ds.key)]: String(after(air)) });
  }, [air, total]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "ArrowLeft" && next > 1)
        (e.preventDefault(), onDraft({ [rowKey(ds.key)]: String(next - 1) }));
      else if (e.key === "ArrowRight" && next < total)
        (e.preventDefault(), onDraft({ [rowKey(ds.key)]: String(next + 1) }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Auto: how far into this row's time (it counts once the graphic holds on air).
  const [receivedAt, setReceivedAt] = useState(Date.now());
  useEffect(() => setReceivedAt(Date.now()), [onAir]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!auto || !onAir) return;
    const h = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(h);
  }, [auto, !!onAir]); // eslint-disable-line react-hooks/exhaustive-deps
  let progress = 0;
  if (
    auto &&
    onAir &&
    onAir.phase === "holding" &&
    !onAir.next &&
    onAir.frame >= holdFrame(template) - 1e-6
  ) {
    const held = onAir.held ?? 0;
    const shown = parseFloat(onAir.data[shownKey(ds.key)] ?? "");
    const frames = Number.isFinite(shown)
      ? Math.min(held, (onAir.age ?? 0) - shown)
      : held;
    progress = Math.min(
      1,
      (frames / fps + (Date.now() - receivedAt) / 1000) / auto,
    );
  }

  return (
    <div className="ods">
      <div className="ods-bar">
        <Rows3 size={14} className="ods-icon" />
        <strong>{ds.name}</strong>
        <div className="opx-seg tiny" title="How the graphic changes row">
          {CHANGES.map((x) => (
            <button
              key={x.id}
              className={change === x.id ? "on" : ""}
              title={x.hint}
              disabled={!operate}
              onClick={() => set({ [changeKey(ds.key)]: x.id })}
            >
              {x.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className="opx-btn small"
          title="Previous row as NEXT (←)"
          disabled={next <= 1}
          onClick={() => onDraft({ [rowKey(ds.key)]: String(next - 1) })}
        >
          <ChevronLeft size={13} />
        </button>
        <button
          className="opx-btn small"
          title="Following row as NEXT (→)"
          disabled={next >= total}
          onClick={() => onDraft({ [rowKey(ds.key)]: String(next + 1) })}
        >
          <ChevronRight size={13} />
        </button>
        <span className="muted small ods-pos">
          next <b className="ods-next">{next}</b> / {total}
          {air !== null && (
            <>
              {" "}
              · air <b className="ods-air">{air}</b>
            </>
          )}
        </span>
        <span className="ods-break" />
        <button
          className={`ods-switch ${auto ? "on" : ""}`}
          disabled={!operate}
          title="The next row by itself, once the graphic holds on air; only you stop it"
          onClick={() => set({ [autoKey(ds.key)]: auto ? "" : String(every) })}
        >
          <span className="ods-knob" />
          Auto next
        </button>
        <input
          className="ods-every"
          type="number"
          min={1}
          max={3600}
          value={every}
          title="Seconds per row"
          onChange={(e) => {
            const v = Math.max(1, +e.target.value || 1);
            setEvery(v);
            if (auto) set({ [autoKey(ds.key)]: String(v) });
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className="muted small">s</span>
        <button
          className={`ods-switch ${loop ? "on" : ""}`}
          title="After the last row, the first again"
          onClick={() => set({ [loopKey(ds.key)]: loop ? "" : "1" })}
        >
          <span className="ods-knob" />
          <Repeat size={13} /> Loop
        </button>
        {usesLines && (
          <button
            className={`ods-switch ${one ? "on" : ""}`}
            title="The text shows only the current row, instead of all of them"
            onClick={() => set({ [oneKey(ds.key)]: one ? "" : "1" })}
          >
            <span className="ods-knob" />
            One entry
          </button>
        )}
      </div>
      {auto > 0 && (
        <div className="ods-prog line">
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div className="ods-rows">
        {t === undefined && <p className="opx-hint pad">Loading the rows…</p>}
        {t === null && (
          <p className="opx-hint pad">No data from {ds.source} yet.</p>
        )}
        {table && (
          <table>
            <thead>
              <tr>
                <th />
                <th>#</th>
                {table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => {
                const n = i + 1;
                const isAir = air === n;
                const isNext = n === next;
                const entry = table.entry[i];
                return (
                  <tr
                    key={i}
                    className={`${isAir ? "air" : isNext ? "next" : ""} ${entry !== null ? "manual" : ""}`}
                    onClick={() => onDraft({ [rowKey(ds.key)]: String(n) })}
                    onDoubleClick={() => operate && show(n)}
                    title="Click: next · double-click: on air"
                  >
                    <td className="ods-tag">
                      {isAir ? (
                        <span className="ods-badge air">AIR</span>
                      ) : isNext ? (
                        <span className="ods-badge next">NEXT</span>
                      ) : null}
                    </td>
                    <td className="ods-n">
                      {n}
                      {entry !== null && (
                        <span className="ods-manual">manual</span>
                      )}
                    </td>
                    {r.map((c, j) => (
                      <td key={j}>
                        <Cell v={c} />
                      </td>
                    ))}
                    <td className="ods-x">
                      {entry !== null && (
                        <button
                          title="Remove this row added by hand"
                          onClick={(e) => {
                            e.stopPropagation();
                            set({
                              [addedKey(ds.key)]: JSON.stringify(
                                added.filter((_, k) => k !== entry),
                              ),
                            });
                          }}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** How a graphic changes row (the operator's choice, kept in the item; the Designer's is the default). */
const CHANGES: { id: RowChange; label: string; hint: string }[] = [
  {
    id: "outIn",
    label: "Out › In",
    hint: "The graphic goes out, then comes in with the new row",
  },
  { id: "fade", label: "Fade", hint: "Cross-fade to the new row" },
  { id: "cut", label: "Cut", hint: "The values change at once" },
];
const changeKey = (k: string) => `${k}__change`;

/**
 * Values set by hand on air, and rows added by hand, of a data set: in the
 * left part of the item, with its fields.
 */
export function DataSetHand({
  ds,
  template,
  draft,
  onAir,
  operate,
  zone,
  onDraft,
  command,
}: {
  ds: DataSet;
  template: Template;
  draft: Data;
  onAir: PlayoutItem | undefined;
  operate: boolean;
  zone: string | undefined;
  onDraft: (patch: Data) => void;
  command: (c: Command) => void;
}) {
  const t = useDatasetRows(ds, draft);
  const serverOffset = useApp((s) => s.serverOffset ?? 0);
  const live = onAir ? shownData(onAir) : undefined;
  const conf = live ?? draft;
  const added = parseAdded(conf[addedKey(ds.key)]);
  const table = t ? withAdded(t, added) : null;
  const total = table?.rows.length ?? 0;
  const air = live ? Math.min(rowOf(live, ds), Math.max(total, 1)) : null;
  const [, tick] = useState(0);
  const set = (patch: Data) => {
    onDraft(patch);
    if (onAir) command({ action: "update", zone, data: patch });
  };
  // Values set by hand on air.
  const manual = live
    ? Object.entries(live).filter(
        ([k, v]) => k.endsWith("__manual") && v.trim(),
      )
    : [];
  const cols = table?.columns ?? [];
  const [ovKey, setOvKey] = useState("");
  const [ovValue, setOvValue] = useState("");
  const [ovMode, setOvMode] = useState<"for" | "trigger" | "removed">("for");
  const [ovSecs, setOvSecs] = useState(10);
  const [ovTrigger, setOvTrigger] = useState("end");
  const targets = [
    ...cols.map((c) => ({ key: columnKey(ds.key, c), label: c })),
    ...template.fields.map((f) => ({ key: f.key, label: f.label })),
  ];
  const target = targets.find((x) => x.key === ovKey) ?? targets[0];
  const [newRow, setNewRow] = useState<Record<string, string>>({});
  const [where, setWhere] = useState<"after" | "end">("after");
  const label = (k: string) => targets.find((x) => x.key === k)?.label ?? k;
  const remaining = (m: string) => {
    if (m === "removed") return "until removed";
    if (m.startsWith("trigger:")) return `until “${m.slice(8)}”`;
    if (m.startsWith("until:"))
      return `${Math.max(0, Math.ceil((+m.slice(6) - (Date.now() + serverOffset)) / 1000))} s left`;
    return m;
  };
  useEffect(() => {
    if (!manual.some(([, m]) => m.startsWith("until:"))) return;
    const h = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(h);
  }, [manual.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ods-hand">
      <span className="opx-label">
        <span>
          <PenLine size={12} /> Values by hand
          {template.datasets && template.datasets.length > 1
            ? ` · ${ds.name}`
            : ""}
        </span>
      </span>
      <div className="ods-line">
        <select
          value={target?.key ?? ""}
          onChange={(e) => setOvKey(e.target.value)}
        >
          {targets.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
            </option>
          ))}
        </select>
        <input
          placeholder="Value"
          value={ovValue}
          onChange={(e) => setOvValue(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="opx-seg tiny">
          <button
            className={ovMode === "for" ? "on" : ""}
            title="For a number of seconds"
            onClick={() => setOvMode("for")}
          >
            For
          </button>
          <button
            className={ovMode === "trigger" ? "on" : ""}
            title="Until a trigger is fired"
            onClick={() => setOvMode("trigger")}
          >
            Trigger
          </button>
          <button
            className={ovMode === "removed" ? "on" : ""}
            title="Until you remove it"
            onClick={() => setOvMode("removed")}
          >
            Removed
          </button>
        </div>
        {ovMode === "for" && (
          <>
            <input
              type="number"
              className="ods-num"
              min={1}
              value={ovSecs}
              onChange={(e) => setOvSecs(Math.max(1, +e.target.value || 1))}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <span className="muted small">s</span>
          </>
        )}
        {ovMode === "trigger" && (
          <input
            className="ods-trigger"
            value={ovTrigger}
            onChange={(e) => setOvTrigger(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            title="Trigger name"
          />
        )}
        <button
          className="opx-btn small"
          disabled={!onAir || !operate || !target}
          title={onAir ? "Set this value on air now" : "Take the graphic first"}
          onClick={() =>
            target &&
            command({
              action: "update",
              zone,
              data: {
                [target.key]: ovValue,
                [manualKey(target.key)]:
                  ovMode === "for"
                    ? `for:${ovSecs}`
                    : ovMode === "trigger"
                      ? `trigger:${ovTrigger.trim() || "end"}`
                      : "removed",
              },
            })
          }
        >
          Override
        </button>
      </div>
      {manual.map(([k, m]) => {
        const key = k.slice(0, -"__manual".length);
        return (
          <div key={k} className="ods-override">
            <PenLine size={12} />
            <b>{label(key)}</b> = {live?.[key]}
            <span className="ods-left">{remaining(m)}</span>
            <button
              title="Back to the data"
              onClick={() =>
                command({
                  action: "update",
                  zone,
                  data: {
                    [k]: "",
                    ...(template.fields.some((f) => f.key === key)
                      ? { [key]: draft[key] ?? "" }
                      : {}),
                  },
                })
              }
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <span className="opx-label ods-hand-sub">Add a row</span>
      <div className="ods-line">
        {cols.map((c) => (
          <input
            key={c}
            placeholder={c}
            value={newRow[c] ?? ""}
            onChange={(e) => setNewRow({ ...newRow, [c]: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
          />
        ))}
        <div className="opx-seg tiny">
          <button
            className={where === "after" ? "on" : ""}
            disabled={air === null}
            title="After the row on air"
            onClick={() => setWhere("after")}
          >
            After air
          </button>
          <button
            className={where === "end" || air === null ? "on" : ""}
            title="At the end of the list"
            onClick={() => setWhere("end")}
          >
            At the end
          </button>
        </div>
        <button
          className="opx-btn small"
          disabled={!Object.values(newRow).some((v) => v.trim())}
          onClick={() => {
            const at = where === "after" && air !== null ? air + 1 : null;
            const cells = Object.fromEntries(
              Object.entries(newRow).filter(([, v]) => v.trim()),
            );
            // The added row is next; the one on air stays.
            set({
              [addedKey(ds.key)]: JSON.stringify([
                ...added,
                at ? { at, cells } : { cells },
              ]),
            });
            onDraft({ [rowKey(ds.key)]: String(at ?? total + 1) });
            setNewRow({});
          }}
        >
          <Plus size={12} /> Add row
        </button>
      </div>
    </div>
  );
}

/** The rows of the data sets of a graphic on air (its controls): NEXT row, previous / following. */
export function AirRows({
  sets,
  item,
  command,
  zone,
  nextRowOf,
}: {
  sets: DataSet[];
  item: PlayoutItem;
  command: (c: Command) => void;
  zone: string;
  nextRowOf?: (dataset: string) => number | undefined;
}) {
  useEffect(() => {
    // N: the NEXT row of the first data set.
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest("input, textarea, select") ||
        e.key.toLowerCase() !== "n" ||
        e.metaKey ||
        e.ctrlKey
      )
        return;
      const ds = sets[0];
      if (!ds) return;
      e.preventDefault();
      command({ action: "row", dataset: ds.key, row: nextOf(ds), zone });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const nextOf = (ds: DataSet) => {
    const data = shownData(item);
    const row = rowOf(data, ds);
    const total = parseInt(item.data[`${ds.key}__count`] ?? "0", 10) || 0;
    const loop = data[loopKey(ds.key)] === "1";
    const chosen = nextRowOf?.(ds.key);
    if (chosen && chosen !== row && chosen <= Math.max(total, chosen))
      return chosen;
    return row < total ? row + 1 : loop ? 1 : row;
  };
  return (
    <>
      {sets.map((ds) => {
        const data = shownData(item);
        const row = rowOf(data, ds);
        const total = parseInt(item.data[`${ds.key}__count`] ?? "0", 10) || 0;
        const auto = parseFloat(data[autoKey(ds.key)] ?? "") || 0;
        const go = (r: number) =>
          command({ action: "row", dataset: ds.key, row: r, zone });
        const next = nextOf(ds);
        return (
          <div key={ds.key} className="opx-rows">
            <div className="opx-rows-head">
              <Rows3 size={13} className="ods-icon" />
              <span className="opx-widget-name">
                <strong>{ds.name}</strong>
                <span className="muted small">
                  row {row} / {total}
                  {auto ? ` · auto every ${auto} s` : ""}
                </span>
              </span>
              <button
                className="opx-sq"
                title="Previous row"
                disabled={row <= 1}
                onClick={() => go(row - 1)}
              >
                <ChevronLeft size={13} />
              </button>
              <button
                className="opx-sq"
                title="Following row"
                disabled={row >= total}
                onClick={() => go(row + 1)}
              >
                <ChevronRight size={13} />
              </button>
            </div>
            <button
              className="opx-btn big green"
              disabled={next === row}
              onClick={() => go(next)}
              title="Show the NEXT row on air (N)"
            >
              <ChevronsRight size={16} /> Next row · {next}
            </button>
          </div>
        );
      })}
    </>
  );
}
