import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { STATUS_LABELS } from '../format';

export function ProtectedRoute({ children }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
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
    <p className="muted spinner" role="status">
      {label}
    </p>
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
