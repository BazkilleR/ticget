import { Link } from 'react-router';
import { Icon, Poster } from './common';
import { formatDate, formatDateTime, formatPrice, isSaleOpen } from '../format';

export function SaleChip({ event }) {
  return isSaleOpen(event) ? (
    <span className="chip chip-open">เปิดขายแล้ว</span>
  ) : (
    <span className="chip chip-soon">เปิดขาย {formatDateTime(event.saleOpensAt)}</span>
  );
}

export function EventCard({ event }) {
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
          {event.minPrice != null && (
            <p className="event-card-price">
              เริ่มต้น <b>{formatPrice(event.minPrice)}</b>
            </p>
          )}
          <span className={`btn btn-block ${open ? 'btn-primary' : 'btn-outline'}`}>
            {open ? 'ซื้อบัตร' : `เปิดขาย ${formatDateTime(event.saleOpensAt)}`}
          </span>
        </div>
      </Link>
    </li>
  );
}
