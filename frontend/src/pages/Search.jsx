import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { request, errorMessage } from '../api/client';
import { ErrorBanner, Icon, Spinner } from '../components/common';
import { EventCard } from '../components/EventCard';

const FILTER_KEYS = ['q', 'from', 'to', 'sale', 'maxPrice', 'sort'];
const TYPING_DELAY_MS = 300;

const SALE_OPTIONS = [
  ['', 'ทั้งหมด'],
  ['open', 'เปิดขายแล้ว'],
  ['upcoming', 'เร็ว ๆ นี้'],
];

// The URL is the single source of truth for the filters, so a search can be shared, bookmarked and
// survives reload and back/forward. Only the text box keeps a local copy, to debounce typing.
export default function Search() {
  const [params, setParams] = useSearchParams();
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const urlQ = params.get('q') ?? '';
  const [qInput, setQInput] = useState(urlQ);
  const sentQ = useRef(urlQ);

  // Follow the URL when it changes from outside this box (header search, back button), but not when it
  // is just catching up with this box, which would wipe what was typed since.
  useEffect(() => {
    if (urlQ !== sentQ.current) setQInput(urlQ);
    sentQ.current = urlQ;
  }, [urlQ]);

  function setFilter(key, value, { replace = false } = {}) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace },
    );
  }

  // Typing replaces the history entry instead of adding one per keystroke.
  useEffect(() => {
    const q = qInput.trim();
    if (q === urlQ) return undefined;
    const timer = setTimeout(() => {
      sentQ.current = q;
      setFilter('q', q, { replace: true });
    }, TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [qInput, urlQ]);

  // Only known, non-empty filters go to the API; with none it serves the cached full list.
  const query = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const queryString = query.toString();
  const hasFilters = queryString !== '';

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    request(`/events${queryString ? `?${queryString}` : ''}`, { signal: controller.signal })
      .then(setResults)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [queryString]);

  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sale = params.get('sale') ?? '';

  return (
    <section className="wrap section">
      <h1 className="section-title">ค้นหางานแสดง</h1>

      <form className="panel search-panel" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="search-box">
          <Icon name="search" />
          <span className="sr-only">ชื่องานหรือสถานที่</span>
          <input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="ค้นหาชื่องานหรือสถานที่"
            maxLength={100}
          />
        </label>

        <div className="filter-row">
          <label className="field">
            <span>ตั้งแต่วันที่</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFilter('from', e.target.value)} />
          </label>
          <label className="field">
            <span>ถึงวันที่</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setFilter('to', e.target.value)} />
          </label>
          <label className="field">
            <span>ราคาไม่เกิน (บาท)</span>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="100"
              placeholder="ไม่จำกัด"
              value={params.get('maxPrice') ?? ''}
              onChange={(e) => setFilter('maxPrice', e.target.value.replace(/\D/g, ''), { replace: true })}
            />
          </label>
          <label className="field">
            <span>เรียงตาม</span>
            <select value={params.get('sort') ?? 'date'} onChange={(e) => setFilter('sort', e.target.value === 'date' ? '' : e.target.value)}>
              <option value="date">วันแสดง (ใกล้สุดก่อน)</option>
              <option value="price">ราคาเริ่มต้น (ถูกสุดก่อน)</option>
            </select>
          </label>
        </div>

        <div className="filter-foot">
          <div className="segmented" role="group" aria-label="สถานะการขาย">
            {SALE_OPTIONS.map(([value, label]) => (
              <button
                key={value || 'all'}
                type="button"
                className={sale === value ? 'active' : undefined}
                aria-pressed={sale === value}
                onClick={() => setFilter('sale', value)}
              >
                {label}
              </button>
            ))}
          </div>
          {hasFilters && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setParams({})}>
              ล้างตัวกรอง
            </button>
          )}
        </div>
      </form>

      <ErrorBanner message={error} />
      {!results && !error && <Spinner />}
      {results && !error && (
        <>
          <p className="result-count" aria-live="polite">
            {hasFilters ? `พบ ${results.length.toLocaleString('th-TH')} งาน` : `งานทั้งหมด ${results.length.toLocaleString('th-TH')} งาน`}
          </p>
          {results.length === 0 ? (
            <p className="empty">ไม่พบงานแสดงที่ตรงกับการค้นหา</p>
          ) : (
            <ul className="event-grid">
              {results.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
