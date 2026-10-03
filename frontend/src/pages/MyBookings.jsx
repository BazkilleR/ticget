import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/client';
import { useApi } from '../auth/AuthContext';
import { ErrorBanner, Spinner, StatusBadge } from '../components/common';
import { FAIL_REASONS, formatDateTime } from '../format';

export default function MyBookings() {
  const api = useApi();
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api('/me/bookings', { signal: controller.signal })
      .then(setBookings)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [api]);

  return (
    <section>
      <h1>การจองของฉัน</h1>
      <ErrorBanner message={error} />
      {!bookings && !error && <Spinner />}
      {bookings?.length === 0 && (
        <p className="empty muted">
          ยังไม่มีการจอง · <Link to="/">ดูอีเวนต์</Link>
        </p>
      )}
      <ul className="list">
        {bookings?.map((b) => (
          <li key={b.bookingId}>
            <Link to={`/bookings/${b.bookingId}`} className="card card-link booking-row">
              <div>
                <strong>{b.eventName}</strong>
                <p className="muted small">
                  โซน {b.zoneName} · {b.quantity} ใบ · {formatDateTime(b.createdAt)}
                </p>
                {b.status === 'FAILED' && b.failReason && (
                  <p className="small sold-out">{FAIL_REASONS[b.failReason] || b.failReason}</p>
                )}
              </div>
              <StatusBadge status={b.status} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
