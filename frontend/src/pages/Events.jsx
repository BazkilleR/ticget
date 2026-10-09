import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { request, errorMessage } from '../api/client';
import { ErrorBanner, Icon, Poster, Spinner } from '../components/common';
import { EventCard, SaleChip } from '../components/EventCard';
import { formatDate, formatTime, isSaleOpen } from '../format';

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
        <div className="section-head">
          <h2 className="section-title">อีเวนต์ทั้งหมด</h2>
          <nav className="quick-filters" aria-label="ตัวกรองด่วน">
            <Link to="/search?sale=open" className="filter-chip">
              เปิดขายแล้ว
            </Link>
            <Link to="/search?sale=upcoming" className="filter-chip">
              เร็ว ๆ นี้
            </Link>
            <Link to="/search" className="filter-chip">
              <Icon name="search" size={15} />
              ค้นหาเพิ่มเติม
            </Link>
          </nav>
        </div>
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
