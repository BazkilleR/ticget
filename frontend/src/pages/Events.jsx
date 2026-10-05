import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { request, errorMessage } from '../api/client';
import { ErrorBanner, Icon, Poster, Spinner } from '../components/common';
import { formatDate, formatDateTime, formatTime, isSaleOpen } from '../format';

function SaleChip({ event }) {
  return isSaleOpen(event) ? (
    <span className="chip chip-open">เปิดขายแล้ว</span>
  ) : (
    <span className="chip chip-soon">เปิดขาย {formatDateTime(event.saleOpensAt)}</span>
  );
}

function Hero({ event }) {
  return (
    <section className="hero">
      <div className="wrap hero-inner">
        <Link to={`/events/${event.id}`} className="hero-poster">
          <Poster event={event} variant="hero" />
        </Link>
        <div className="hero-info">
          <SaleChip event={event} />
          <h1>{event.name}</h1>
          <ul className="meta meta-light">
            <li>
              <Icon name="calendar" />
              {formatDate(event.startsAt)}
            </li>
            <li>
              <Icon name="clock" />
              {formatTime(event.startsAt)}
            </li>
            <li>
              <Icon name="pin" />
              {event.venue}
            </li>
          </ul>
          <Link to={`/events/${event.id}`} className="btn btn-primary btn-lg">
            <Icon name="ticket" />
            {isSaleOpen(event) ? 'ซื้อบัตร' : 'ดูรายละเอียด'}
          </Link>
        </div>
      </div>
    </section>
  );
}

function EventCard({ event }) {
  const open = isSaleOpen(event);
  return (
    <li>
      <Link to={`/events/${event.id}`} className="event-card">
        <Poster event={event} />
        <div className="event-card-body">
          <p className="event-card-date">{formatDate(event.startsAt)}</p>
          <h3>{event.name}</h3>
          <p className="event-card-venue">
            <Icon name="pin" size={15} />
            {event.venue}
          </p>
          <span className={`btn btn-block ${open ? 'btn-primary' : 'btn-outline'}`}>
            {open ? 'ซื้อบัตร' : `เปิดขาย ${formatDateTime(event.saleOpensAt)}`}
          </span>
        </div>
      </Link>
    </li>
  );
}

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

  const featured = events?.find(isSaleOpen) || events?.[0];

  return (
    <>
      {featured && <Hero event={featured} />}
      <section className="wrap section">
        <h2 className="section-title">อีเวนต์ทั้งหมด</h2>
        <ErrorBanner message={error} />
        {!events && !error && <Spinner />}
        {events?.length === 0 && <p className="empty">ยังไม่มีอีเวนต์ที่กำลังจะมาถึง</p>}
        <ul className="event-grid">
          {events?.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </ul>
      </section>
    </>
  );
}
