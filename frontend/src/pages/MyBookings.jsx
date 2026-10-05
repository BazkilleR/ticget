import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/client';
import { useApi } from '../auth/AuthContext';
import { ErrorBanner, Poster, Spinner, StatusBadge } from '../components/common';
import { FAIL_REASONS, formatDateTime } from '../format';

const TABS = [
  { key: 'all', label: 'ทั้งหมด', match: () => true },
  { key: 'pending', label: 'รอชำระเงิน', match: (b) => b.status === 'PENDING' },
  { key: 'confirmed', label: 'สำเร็จ', match: (b) => b.status === 'CONFIRMED' },
  { key: 'other', label: 'ไม่สำเร็จ / หมดเวลา', match: (b) => b.status === 'FAILED' || b.status === 'EXPIRED' },
];

export default function MyBookings() {
  const api = useApi();
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('all');

  useEffect(() => {
    const controller = new AbortController();
    api('/me/bookings', { signal: controller.signal })
      .then(setBookings)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [api]);

  const { match } = TABS.find((t) => t.key === tab);
  const shown = bookings?.filter(match);

  return (
    <section className="wrap section narrow">
      <h1 className="section-title">บัตรของฉัน</h1>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {bookings && <span className="tab-count">{bookings.filter(t.match).length}</span>}
          </button>
        ))}
      </div>

      <ErrorBanner message={error} />
      {!bookings && !error && <Spinner />}
      {shown?.length === 0 && (
        <div className="empty">
          <p>ไม่มีรายการ</p>
          <Link to="/" className="btn btn-primary">
            ดูอีเวนต์
          </Link>
        </div>
      )}
      <ul className="booking-list">
        {shown?.map((b) => (
          <li key={b.bookingId}>
            <Link to={`/bookings/${b.bookingId}`} className="booking-item">
              <Poster event={{ id: b.eventId, name: b.eventName }} variant="mini" />
              <div className="booking-item-body">
                <strong>{b.eventName}</strong>
                <span>
                  โซน {b.zoneName} · {b.quantity} ใบ
                </span>
                <span className="fine-print">จองเมื่อ {formatDateTime(b.createdAt)}</span>
                {b.status === 'FAILED' && b.failReason && (
                  <span className="text-danger">{FAIL_REASONS[b.failReason] || b.failReason}</span>
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
