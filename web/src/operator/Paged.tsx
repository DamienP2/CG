import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';

/*
 * Every list of data rows in the Operator (data set rows, row pickers, a
 * table's rows): 8 entries at a time, with a search field and pages.
 */

export const PAGE_SIZE = 8;

export interface Paged<T> {
  query: string;
  setQuery: (q: string) => void;
  page: number;
  setPage: (p: number) => void;
  pages: number;
  /** Entries matching the search. */
  matching: number;
  /** All the entries. */
  total: number;
  /** The entries of this page, with their index in the whole list. */
  shown: { item: T; index: number }[];
}

/**
 * Pages of `items` filtered by `query` (any of `text(item)`, any case).
 * `focus`: the index of an entry to keep in view (the NEXT row…): its page
 * is shown when it changes, unless a search hides it.
 */
export function usePaged<T>(items: T[], text: (item: T) => string, focus?: number | null, size = PAGE_SIZE): Paged<T> {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const all = items.map((item, index) => ({ item, index }));
    return q ? all.filter((x) => text(x.item).toLowerCase().includes(q)) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q]);
  const pages = Math.max(1, Math.ceil(matches.length / size));
  const at = Math.min(page, pages - 1);
  // The focused entry's page when it changes.
  useEffect(() => {
    if (focus == null || focus < 0) return;
    const i = matches.findIndex((x) => x.index === focus);
    if (i >= 0) setPage(Math.floor(i / size));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, items.length]);
  return {
    query,
    setQuery: (v) => (setQuery(v), setPage(0)),
    page: at,
    setPage: (p) => setPage(Math.max(0, Math.min(pages - 1, p))),
    pages,
    matching: matches.length,
    total: items.length,
    shown: matches.slice(at * size, at * size + size),
  };
}

/** The search field and the pages of a list: "1–8 of 42", previous / next. */
export function Pager<T>({ paged, size = PAGE_SIZE, placeholder }: { paged: Paged<T>; size?: number; placeholder?: string }) {
  const { query, setQuery, page, setPage, pages, matching, total } = paged;
  // A short list fits: no search, no pages.
  if (total <= size && !query) return null;
  const a = matching ? page * size + 1 : 0;
  const b = Math.min(matching, (page + 1) * size);
  return (
    <div className="opg">
      <label className="opg-search">
        <Search size={12} />
        <input
          value={query}
          placeholder={placeholder ?? t('Search')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setQuery('');
          }}
        />
        {query && (
          <button title={t('Clear the search')} onClick={() => setQuery('')}>
            <X size={11} />
          </button>
        )}
      </label>
      <span className="opg-count">
        {matching ? t('{a}–{b} of {n}', { a, b, n: matching }) : t('No match')}
        {query.trim() && matching !== total && <span className="muted"> {t('({n} in all)', { n: total })}</span>}
      </span>
      <button className="opx-sq" title={t('Previous page')} disabled={page <= 0} onClick={() => setPage(page - 1)}>
        <ChevronLeft size={13} />
      </button>
      <button className="opx-sq" title={t('Next page')} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
        <ChevronRight size={13} />
      </button>
    </div>
  );
}
