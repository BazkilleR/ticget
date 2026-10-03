import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { request, errorMessage } from '../api/client';
import { ErrorBanner, Spinner } from '../components/common';
import { formatDateTime } from '../format';

export default function Events() {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    request('/events', { signal: controller.signal })
      .then(setEvents)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);

  return (
    <section>
      <h1>อีเวนต์ที่กำลังจะมาถึง</h1>
      <ErrorBanner message={error} />
      {!events && !error && <Spinner />}
      {events?.length === 0 && <p className="empty muted">ยังไม่มีอีเวนต์</p>}
      <ul className="grid">
        {events?.map((event) => {
          const saleOpen = new Date(event.saleOpensAt) <= new Date();
          return (
            <li key={event.id}>
              <Link to={`/events/${event.id}`} className="card card-link event-card">
                <h2>{event.name}</h2>
                <p className="muted">{event.venue}</p>
                <p>{formatDateTime(event.startsAt)}</p>
                <span className={`badge ${saleOpen ? 'badge-confirmed' : 'badge-queued'}`}>
                  {saleOpen ? 'เปิดขายแล้ว' : `เปิดขาย ${formatDateTime(event.saleOpensAt)}`}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
