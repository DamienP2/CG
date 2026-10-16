import { useEffect, useRef, useState } from 'react';
import { parseHex, toHex } from '../engine/evaluate';
import type { Color } from '../engine/types';

/** Number input with AE-style scrubbing on its label. */
export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  display = 1,
  precision = 0,
  suffix,
  min,
  max,
  title,
}: {
  label?: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  /** Display multiplier (e.g. 100 to show a 0..1 value as a percentage). */
  display?: number;
  precision?: number;
  suffix?: string;
  min?: number;
  max?: number;
  title?: string;
}) {
  const shown = +(value * display).toFixed(precision);
  const [text, setText] = useState(String(shown));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(shown));
  }, [shown]);

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (s: string) => {
    // Allow simple expressions: "100+20", "1920/2".
    const expr = s.replace(/[^-+*/().\d\s]/g, '');
    let v: number;
    try {
      v = Function(`"use strict";return (${expr || 0})`)() as number;
    } catch {
      v = NaN;
    }
    if (Number.isFinite(v)) onChange(clamp(v / display));
    else setText(String(shown));
  };

  const scrub = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const start = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      onChange(clamp(start + ((ev.clientX - startX) * step * mult) / display));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <label className="num-field" title={title}>
      {label !== undefined && (
        <span className="scrub" onPointerDown={scrub}>
          {label}
        </span>
      )}
      <input
        value={text}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.target.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            onChange(clamp(value + d / display));
          }
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </label>
  );
}

export function ColorField({ value, onChange }: { value: Color; onChange: (c: Color) => void }) {
  const [text, setText] = useState(toHex(value, true));
  useEffect(() => setText(toHex(value, true)), [value]);
  return (
    <div className="color-field">
      <label className="swatch" style={{ ['--c' as string]: `rgba(${value[0] * 255},${value[1] * 255},${value[2] * 255},${value[3]})` }}>
        <input
          type="color"
          value={toHex(value)}
          onChange={(e) => {
            const c = parseHex(e.target.value);
            if (c) onChange([c[0], c[1], c[2], value[3]]);
          }}
        />
      </label>
      <input
        className="hex"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const c = parseHex(text);
          if (c) onChange(c);
          else setText(toHex(value, true));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <NumberField value={value[3]} display={100} min={0} max={1} suffix="%" onChange={(a) => onChange([value[0], value[1], value[2], a])} />
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  multiline,
  placeholder,
  commitOnBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  commitOnBlur?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const props = {
    value: text,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      if (!commitOnBlur) onChange(e.target.value);
    },
    onBlur: () => commitOnBlur && text !== value && onChange(text),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !multiline) (e.target as HTMLInputElement).blur();
    },
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
