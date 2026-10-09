import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { STATUS_LABELS, dateParts } from '../format';

export function ProtectedRoute({ children }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

// Hides admin pages from normal users. This is only UX: every /admin API call is checked server-side.
export function AdminRoute({ children }) {
  const { token, isAdmin } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!isAdmin) {
    return (
      <section className="wrap empty">
        <h1>ไม่มีสิทธิ์เข้าถึง</h1>
        <p>หน้านี้สำหรับผู้ดูแลระบบเท่านั้น</p>
      </section>
    );
  }
  return children;
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <p className="banner banner-error" role="alert">
      {message}
    </p>
  );
}

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABELS[status] || status}</span>;
}

export function Spinner({ label = 'กำลังโหลด…' }) {
  return (
    <p className="spinner" role="status">
      <span className="spinner-ring" aria-hidden="true" />
      {label}
    </p>
  );
}

const ICONS = {
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  ticket: 'M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4zM15 7v10',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  check: 'M5 12l5 5L20 7',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2M14 18h2v2M18 18h2v2h-2z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
};

export function Icon({ name, size = 18 }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// Events have no artwork in the API, so each one gets a generated poster whose colours are picked from its id
// (stable across pages and reloads).
const POSTER_THEMES = [
  ['#ff3d4a', '#4a0614'],
  ['#ff9a1f', '#6b1250'],
  ['#2f8cff', '#121a52'],
  ['#14c79a', '#08334a'],
  ['#b45cff', '#1f0a3d'],
  ['#ffc21a', '#7c1d05'],
];

export function Poster({ event, variant = 'card' }) {
  const [from, to] = POSTER_THEMES[Math.abs(Number(event.id) || 0) % POSTER_THEMES.length];
  const date = event.startsAt ? dateParts(event.startsAt) : null;
  return (
    <div className={`poster poster-${variant}`} style={{ '--from': from, '--to': to }} aria-hidden="true">
      <span className="poster-glow" />
      <span className="poster-rings" />
      {date && (
        <span className="poster-date">
          <b>{date.day}</b>
          {date.month}
        </span>
      )}
      <span className="poster-title">{event.name}</span>
      {event.venue && <span className="poster-venue">{event.venue}</span>}
    </div>
  );
}

const STEPS = ['เลือกโซน', 'ตรวจสอบที่นั่ง', 'ชำระเงิน', 'รับบัตร'];

// current: index of the active step. failed: the active step ended badly (sold out, expired).
export function Steps({ current, failed = false }) {
  return (
    <ol className="steps">
      {STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? (failed ? 'failed' : 'active') : 'todo';
        return (
          <li key={label} className={`step step-${state}`} aria-current={i === current ? 'step' : undefined}>
            <span className="step-dot">{state === 'done' ? <Icon name="check" size={14} /> : i + 1}</span>
            <span className="step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Counts down to `until` (ISO string) and calls onExpire once when it reaches zero. Uses the browser clock,
// so the server stays the authority: the caller refetches on expiry instead of trusting this.
export function Countdown({ until, onExpire }) {
  const target = new Date(until).getTime();
  const [now, setNow] = useState(Date.now);
  const left = Math.max(0, target - now);

  useEffect(() => {
    if (left === 0) {
      onExpire?.();
      return undefined;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(1000, left));
    return () => clearTimeout(timer);
  }, [left, onExpire]);

  const totalSeconds = Math.ceil(left / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return (
    <span className={`countdown${totalSeconds <= 60 ? ' countdown-urgent' : ''}`} aria-live="off">
      {mm}:{ss}
    </span>
  );
}
