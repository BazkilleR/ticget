import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { request, errorMessage } from '../api/client';
import { useApi, useAuth } from '../auth/AuthContext';
import { ErrorBanner, Icon, Poster, Spinner, Steps } from '../components/common';
import { formatDate, formatDateTime, formatPrice, formatTime, isSaleOpen } from '../format';

const ZONES_REFRESH_MS = 5000;
const MAX_PER_BOOKING = 4;
const ZONE_COLORS = ['#e5202e', '#ff8a00', '#2e86de', '#10ac84', '#8e44ad', '#d4a017'];

function EventHeader({ event, zones }) {
  const prices = zones?.map((z) => z.price) ?? [];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return (
    <section className="event-hero">
      <div className="wrap event-hero-inner">
        <Poster event={event} />
        <div className="event-hero-info">
          <Link to="/" className="back-link">
            <Icon name="back" size={16} />
            อีเวนต์ทั้งหมด
          </Link>
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
            {prices.length > 0 && (
              <li>
                <Icon name="ticket" />
                {low === high ? formatPrice(low) : `${formatPrice(low)} – ${formatPrice(high)}`}
              </li>
            )}
          </ul>
          {isSaleOpen(event) ? (
            <span className="chip chip-open">เปิดขายแล้ว</span>
          ) : (
            <span className="chip chip-soon">เปิดขาย {formatDateTime(event.saleOpensAt)}</span>
          )}
        </div>
      </div>
    </section>
  );
}

// Stage plan: the most expensive zone sits closest to the stage and each zone further back is wider.
// It mirrors the radio list in the side panel, which is the accessible control, so it is hidden from
// assistive tech and kept out of the tab order.
function VenueMap({ zones, colors, selectedZoneId, onSelect }) {
  return (
    <div className="venue-map" aria-hidden="true">
      <div className="stage">STAGE</div>
      {zones.map((zone, i) => {
        const soldOut = zone.available <= 0;
        const width = 50 + (50 * i) / Math.max(zones.length - 1, 1);
        return (
          <button
            key={zone.zoneId}
            type="button"
            tabIndex={-1}
            disabled={soldOut}
            className={`map-zone${selectedZoneId === zone.zoneId ? ' selected' : ''}`}
            style={{ '--zone': soldOut ? '#b9b9c2' : colors[zone.zoneId], width: `${width}%` }}
            onClick={() => onSelect(zone.zoneId)}
          >
            <strong>{zone.name}</strong>
            <span>{soldOut ? 'SOLD OUT' : formatPrice(zone.price)}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function EventZones() {
  const { id } = useParams();
  const eventId = Number(id);
  const { token } = useAuth();
  const api = useApi();
  const navigate = useNavigate();

  const [event, setEvent] = useState(null);
  const [zones, setZones] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // One requestId per booking attempt. Retrying the same zone + quantity (after a network error or a 503)
  // reuses it, so if the first try did reach the queue, SQS dedup and the worker turn the retry into a no-op
  // instead of a second booking.
  const attempt = useRef(null);

  useEffect(() => {
    // Header details only; if this fails the zones request reports the error.
    const controller = new AbortController();
    request(`/events/${eventId}`, { signal: controller.signal })
      .then(setEvent)
      .catch(() => {});
    return () => controller.abort();
  }, [eventId]);

  // Availability changes while people book, so poll it. The API caches zones for 3 s, which keeps this cheap.
  useEffect(() => {
    let controller;
    async function load() {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        setZones(await request(`/events/${eventId}/zones`, { signal: controller.signal }));
        setLoadError(null);
      } catch (err) {
        if (err.name !== 'AbortError') setLoadError(errorMessage(err));
      }
    }
    load();
    const timer = setInterval(load, ZONES_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller?.abort();
    };
  }, [eventId]);

  const ranked = zones ? [...zones].sort((a, b) => b.price - a.price) : [];
  const colors = Object.fromEntries(ranked.map((z, i) => [z.zoneId, ZONE_COLORS[i % ZONE_COLORS.length]]));
  const selectedZone = zones?.find((z) => z.zoneId === selectedZoneId);
  const maxQuantity = Math.min(MAX_PER_BOOKING, selectedZone?.available ?? 0);
  const saleOpen = !event || isSaleOpen(event);

  // Keep the chosen quantity valid when availability drops under it.
  useEffect(() => {
    if (maxQuantity > 0 && quantity > maxQuantity) setQuantity(maxQuantity);
  }, [maxQuantity, quantity]);

  async function handleBook(e) {
    e.preventDefault();
    if (!token) {
      navigate('/login', { state: { from: `/events/${eventId}` } });
      return;
    }
    const key = `${selectedZoneId}:${quantity}`;
    if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID() };

    setSubmitting(true);
    setSubmitError(null);
    try {
      const { bookingId } = await api('/bookings', {
        method: 'POST',
        body: { eventId, zoneId: selectedZoneId, quantity, requestId: attempt.current.requestId },
      });
      attempt.current = null;
      navigate(`/bookings/${bookingId}`);
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const canBook = selectedZone && maxQuantity > 0 && saleOpen && !submitting;
  let buttonLabel = 'ยืนยันการจอง';
  if (submitting) buttonLabel = 'กำลังส่งคำขอ…';
  else if (!saleOpen) buttonLabel = 'ยังไม่เปิดขาย';
  else if (!selectedZone) buttonLabel = 'กรุณาเลือกโซน';
  else if (!token) buttonLabel = 'เข้าสู่ระบบเพื่อจอง';

  return (
    <>
      {event ? (
        <EventHeader event={event} zones={zones} />
      ) : (
        <div className="wrap page-head">
          <Link to="/" className="back-link back-link-dark">
            <Icon name="back" size={16} />
            อีเวนต์ทั้งหมด
          </Link>
          <h1>เลือกโซน</h1>
        </div>
      )}

      <section className="wrap section">
        <Steps current={0} />
        {event?.description && (
          <div className="panel event-description">
            <h2 className="panel-title">รายละเอียดงาน</h2>
            <p>{event.description}</p>
          </div>
        )}
        <ErrorBanner message={loadError} />
        {!zones && !loadError && <Spinner />}

        {zones && (
          <form onSubmit={handleBook} className="booking-layout">
            <div className="panel">
              <h2 className="panel-title">ผังที่นั่ง</h2>
              <VenueMap zones={ranked} colors={colors} selectedZoneId={selectedZoneId} onSelect={setSelectedZoneId} />
            </div>

            <div className="panel panel-sticky">
              <h2 className="panel-title">ราคาบัตร</h2>
              <fieldset className="price-list">
                <legend className="sr-only">เลือกโซน</legend>
                {ranked.map((zone) => {
                  const soldOut = zone.available <= 0;
                  return (
                    <label
                      key={zone.zoneId}
                      className={`price-row${selectedZoneId === zone.zoneId ? ' selected' : ''}${soldOut ? ' disabled' : ''}`}
                    >
                      <input
                        type="radio"
                        name="zone"
                        value={zone.zoneId}
                        disabled={soldOut}
                        checked={selectedZoneId === zone.zoneId}
                        onChange={() => setSelectedZoneId(zone.zoneId)}
                      />
                      <span className="zone-dot" style={{ '--zone': soldOut ? '#b9b9c2' : colors[zone.zoneId] }} />
                      <span className="price-row-name">
                        {zone.name}
                        <small className={soldOut ? 'text-danger' : ''}>
                          {soldOut ? 'เต็มแล้ว' : `เหลือ ${zone.available.toLocaleString('th-TH')} ใบ`}
                        </small>
                      </span>
                      <span className="price-row-price">{formatPrice(zone.price)}</span>
                    </label>
                  );
                })}
              </fieldset>

              <div className="qty-row">
                <span id="qty-label">จำนวนบัตร</span>
                <div className="qty" role="group" aria-labelledby="qty-label">
                  <button
                    type="button"
                    aria-label="ลดจำนวน"
                    onClick={() => setQuantity((q) => q - 1)}
                    disabled={!selectedZone || quantity <= 1}
                  >
                    <Icon name="minus" size={16} />
                  </button>
                  <output aria-live="polite">{quantity}</output>
                  <button
                    type="button"
                    aria-label="เพิ่มจำนวน"
                    onClick={() => setQuantity((q) => q + 1)}
                    disabled={!selectedZone || quantity >= maxQuantity}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                </div>
              </div>

              <div className="total-row">
                <span>ยอดรวม</span>
                <strong>{selectedZone ? formatPrice(selectedZone.price * quantity) : '–'}</strong>
              </div>

              <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!canBook}>
                {buttonLabel}
              </button>
              <ErrorBanner message={submitError} />
              <p className="fine-print">
                จำกัด {MAX_PER_BOOKING} ใบต่อคนต่ออีเวนต์ · ต้องชำระเงินภายใน 10 นาทีหลังจองสำเร็จ
              </p>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
