import { Bold, Italic, RemoveFormatting, Strikethrough, Underline } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parse, type Run, type RunStyle } from '../engine/rich';
import { t } from '../i18n';

/*
 * Rich text field (like TinyMCE, kept small): select part of the text, then
 * bold, italic, underline, strike through or a colour. The value is the text
 * with its style tags (engine/rich.ts), so {{key}} and plain texts are kept.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

/** Tags → HTML for the editable box. */
export function toHtml(markup: string): string {
  return parse(markup)
    .map(({ text, style: s }) => {
      let h = esc(text);
      if (s.color) h = `<font color="${s.color}">${h}</font>`;
      if (s.strike) h = `<s>${h}</s>`;
      if (s.underline) h = `<u>${h}</u>`;
      if (s.italic) h = `<i>${h}</i>`;
      if (s.bold) h = `<b>${h}</b>`;
      return h;
    })
    .join('');
}

const rgbHex = (c: string) => {
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? `#${[m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('')}` : c.startsWith('#') ? c : undefined;
};

/** The editable box's HTML → the text with its tags. */
export function fromHtml(root: HTMLElement): string {
  const runs: Run[] = [];
  const push = (text: string, style: RunStyle) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.text += text;
    else runs.push({ text, style: { ...style } });
  };
  const walk = (n: Node, style: RunStyle, first: { v: boolean }) => {
    if (n.nodeType === Node.TEXT_NODE) {
      push((n.textContent ?? '').replace(/ /g, ' ').replace(/[​]/g, ''), style);
      first.v = false;
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const tag = n.tagName;
    if (tag === 'BR') {
      push('\n', style);
      return;
    }
    // A new block (Enter in some browsers): a new line.
    if ((tag === 'DIV' || tag === 'P') && !first.v) push('\n', style);
    const s: RunStyle = { ...style };
    if (tag === 'B' || tag === 'STRONG') s.bold = true;
    if (tag === 'I' || tag === 'EM') s.italic = true;
    if (tag === 'U') s.underline = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.strike = true;
    if (tag === 'FONT' && n.getAttribute('color')) s.color = rgbHex(n.getAttribute('color')!);
    const css = n.style;
    if (css.fontWeight === 'bold' || +css.fontWeight >= 600) s.bold = true;
    if (css.fontStyle === 'italic') s.italic = true;
    if (css.textDecorationLine?.includes('underline') || css.textDecoration?.includes('underline')) s.underline = true;
    if (css.textDecorationLine?.includes('line-through') || css.textDecoration?.includes('line-through')) s.strike = true;
    if (css.color) s.color = rgbHex(css.color);
    n.childNodes.forEach((c) => walk(c, s, first));
  };
  walk(root, {}, { v: true });
  // A trailing line break the box keeps for the caret.
  const last = runs[runs.length - 1];
  if (last?.text.endsWith('\n')) last.text = last.text.slice(0, -1);
  return runs
    .filter((r) => r.text)
    .map(({ text, style: s }) => {
      let t = text;
      if (s.color) t = `<c=${s.color}>${t}</c>`;
      if (s.strike) t = `<s>${t}</s>`;
      if (s.underline) t = `<u>${t}</u>`;
      if (s.italic) t = `<i>${t}</i>`;
      if (s.bold) t = `<b>${t}</b>`;
      return t;
    })
    .join('');
}

const SWATCHES = ['#ffffff', '#ff3b5c', '#facc15', '#22c55e', '#38bdf8', '#7c5cff', '#111111'];

export function RichInput({ value, onChange, multiline, placeholder }: { value: string; onChange: (v: string) => void; multiline?: boolean; placeholder?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const sent = useRef<string | null>(null);
  const [color, setColor] = useState('#ff3b5c');
  const [state, setState] = useState<Record<string, boolean>>({});
  // The value from outside (undo, another field…): the box shows it; its own edits are left as they are.
  useLayoutEffect(() => {
    if (box.current && value !== sent.current) {
      box.current.innerHTML = toHtml(value);
      sent.current = value;
    }
  }, [value]);
  const emit = () => {
    if (!box.current) return;
    const v = fromHtml(box.current);
    sent.current = v;
    if (v !== value) onChange(v);
  };
  const refresh = () =>
    setState({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      strikeThrough: document.queryCommandState('strikeThrough'),
    });
  useEffect(() => {
    const sel = () => box.current?.contains(document.getSelection()?.anchorNode ?? null) && refresh();
    document.addEventListener('selectionchange', sel);
    return () => document.removeEventListener('selectionchange', sel);
  }, []);
  const run = (cmd: string, arg?: string) => {
    box.current?.focus();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(cmd, false, arg);
    emit();
    refresh();
  };
  // Buttons keep the selection (no focus change on press).
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const B = ({ cmd, icon, title }: { cmd: string; icon: React.ReactNode; title: string }) => (
    <button type="button" className={state[cmd] ? 'on' : ''} title={title} onMouseDown={keep} onClick={() => run(cmd)}>
      {icon}
    </button>
  );
  return (
    <div className="rt">
      <div className="rt-bar">
        <B cmd="bold" icon={<Bold size={13} />} title={t('Bold (Ctrl+B)')} />
        <B cmd="italic" icon={<Italic size={13} />} title={t('Italic (Ctrl+I)')} />
        <B cmd="underline" icon={<Underline size={13} />} title={t('Underline (Ctrl+U)')} />
        <B cmd="strikeThrough" icon={<Strikethrough size={13} />} title={t('Strike through')} />
        <span className="rt-sep" />
        {SWATCHES.map((c) => (
          <button key={c} type="button" className="rt-sw" title={t('Colour {c}', { c })} style={{ background: c }} onMouseDown={keep} onClick={() => run('foreColor', c)} />
        ))}
        <label className="rt-pick" title={t('Another colour')} onMouseDown={(e) => e.stopPropagation()}>
          <span style={{ background: color }} />
          <input type="color" value={color} onChange={(e) => (setColor(e.target.value), run('foreColor', e.target.value))} />
        </label>
        <span className="rt-sep" />
        <B cmd="removeFormat" icon={<RemoveFormatting size={13} />} title={t('Back to the style of the whole text')} />
      </div>
      <div
        ref={box}
        className={`rt-box ${multiline ? 'multi' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={multiline}
        data-placeholder={placeholder}
        onInput={emit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            if (multiline) document.execCommand('insertLineBreak');
            else box.current?.blur();
            emit();
          }
          if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            run({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase() as 'b' | 'i' | 'u']);
          }
        }}
        onPaste={(e) => {
          // Pasted text keeps no outside style.
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
      />
    </div>
  );
}
