import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { request, errorMessage } from '../api/client';
import { useApi, useAuth } from '../auth/AuthContext';
import { ErrorBanner, Spinner } from '../components/common';
import { formatDateTime, formatPrice } from '../format';

const ZONES_REFRESH_MS = 5000;
const MAX_PER_BOOKING = 4;

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
    // /events only lists events that have not started; a missing entry just means no header details.
    request('/events')
      .then((list) => setEvent(list.find((e) => e.id === eventId) || null))
      .catch(() => {});
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

  const selectedZone = zones?.find((z) => z.zoneId === selectedZoneId);
  const maxQuantity = Math.min(MAX_PER_BOOKING, selectedZone?.available ?? 0);
  const saleOpen = !event || new Date(event.saleOpensAt) <= new Date();

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

  return (
    <section>
      <p>
        <Link to="/">← อีเวนต์ทั้งหมด</Link>
      </p>
      {event ? (
        <header className="event-header">
          <h1>{event.name}</h1>
          <p className="muted">
            {event.venue} · {formatDateTime(event.startsAt)}
          </p>
          {!saleOpen && (
            <p className="banner banner-info">เปิดขาย {formatDateTime(event.saleOpensAt)}</p>
          )}
        </header>
      ) : (
        <h1>เลือกโซน</h1>
      )}

      <ErrorBanner message={loadError} />
      {!zones && !loadError && <Spinner />}

      {zones && (
        <form onSubmit={handleBook} className="stack">
          <fieldset className="zones">
            <legend className="sr-only">โซน</legend>
            {zones.map((zone) => {
              const soldOut = zone.available <= 0;
              return (
                <label
                  key={zone.zoneId}
                  className={`card zone-card${selectedZoneId === zone.zoneId ? ' selected' : ''}${soldOut ? ' disabled' : ''}`}
                >
                  <input
                    type="radio"
                    name="zone"
                    value={zone.zoneId}
                    disabled={soldOut}
                    checked={selectedZoneId === zone.zoneId}
                    onChange={() => setSelectedZoneId(zone.zoneId)}
                  />
                  <span className="zone-name">{zone.name}</span>
                  <span className="zone-price">{formatPrice(zone.price)}</span>
                  <span className={soldOut ? 'sold-out' : 'muted'}>
                    {soldOut ? 'เต็มแล้ว' : `เหลือ ${zone.available.toLocaleString('th-TH')} ใบ`}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="book-bar card">
            <label className="field field-inline">
              <span>จำนวน</span>
              <select
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                disabled={!selectedZone || maxQuantity === 0}
              >
                {Array.from({ length: Math.max(maxQuantity, 1) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} ใบ
                  </option>
                ))}
              </select>
            </label>
            <span className="total">
              {selectedZone ? formatPrice(selectedZone.price * quantity) : 'เลือกโซนก่อน'}
            </span>
            <button
              type="submit"
              className="button"
              disabled={!selectedZone || maxQuantity === 0 || !saleOpen || submitting}
            >
              {submitting ? 'กำลังส่งคำขอ…' : token ? 'จองเลย' : 'เข้าสู่ระบบเพื่อจอง'}
            </button>
          </div>
          <ErrorBanner message={submitError} />
          <p className="muted small">จำกัด {MAX_PER_BOOKING} ใบต่อคนต่ออีเวนต์ · ต้องชำระเงินภายใน 10 นาทีหลังจองสำเร็จ</p>
        </form>
      )}
    </section>
  );
}
