import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, errorMessage, request } from '../api/client';
import { useApi } from '../auth/AuthContext';
import { Countdown, ErrorBanner, Icon, Poster, Spinner, StatusBadge, Steps } from '../components/common';
import { FAIL_REASONS, formatDate, formatDateTime, formatPrice, formatTime } from '../format';

// The worker usually picks a booking up within a second or two; back off if the queue is busy.
const pollDelay = (attempt) => (attempt < 5 ? 1000 : attempt < 15 ? 2000 : 3000);
const SLOW_QUEUE_ATTEMPTS = 20;

const STEP_FOR_STATUS = { QUEUED: 1, FAILED: 1, PENDING: 2, EXPIRED: 2, CONFIRMED: 4 };

// The booking itself only carries names, so fetch the public event and zone details for the ticket (venue,
// date, price). Best effort: an event that has started drops out of /events and the ticket just shows less.
function useTicketDetails(eventId, zoneId) {
  const [details, setDetails] = useState({});
  useEffect(() => {
    if (!eventId) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    Promise.allSettled([request('/events', { signal }), request(`/events/${eventId}/zones`, { signal })]).then(
      ([events, zones]) => {
        if (signal.aborted) return;
        setDetails({
          event: events.value?.find((e) => e.id === eventId),
          zone: zones.value?.find((z) => z.zoneId === zoneId),
        });
      },
    );
    return () => controller.abort();
  }, [eventId, zoneId]);
  return details;
}

export default function BookingStatus() {
  const { id } = useParams();
  const api = useApi();

  const [booking, setBooking] = useState(null);
  const [error, setError] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const { event, zone } = useTicketDetails(booking?.eventId, booking?.zoneId);

  // POST /bookings only queues the request, so poll until the worker has written a result.
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    let attempt = 0;

    async function poll() {
      try {
        const result = await api(`/bookings/${id}`, { signal: controller.signal });
        setBooking(result);
        setError(null);
        if (result.status === 'QUEUED') {
          attempt += 1;
          setAttempts(attempt);
          timer = setTimeout(poll, pollDelay(attempt));
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(errorMessage(err));
        // Network errors and 5xx are worth retrying; a 4xx (e.g. malformed id) will not fix itself.
        if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
          timer = setTimeout(poll, 3000);
        }
      }
    }

    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, refreshKey]);

  async function handlePay() {
    setPaying(true);
    setPayError(null);
    try {
      await api(`/bookings/${id}/pay`, { method: 'POST' });
    } catch (err) {
      setPayError(errorMessage(err));
    } finally {
      setPaying(false);
      refresh();
    }
  }

  if (!booking) {
    return (
      <section className="wrap section narrow">
        <ErrorBanner message={error} />
        {!error && <Spinner />}
      </section>
    );
  }

  const { status } = booking;

  return (
    <section className="wrap section narrow">
      <Steps current={STEP_FOR_STATUS[status] ?? 1} failed={status === 'FAILED' || status === 'EXPIRED'} />

      {status === 'QUEUED' && (
        <div className="panel queued">
          <div className="queue-anim" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h1>กำลังตรวจสอบที่นั่ง</h1>
          <p>คำขอของคุณอยู่ในคิวแล้ว กรุณาอย่าปิดหรือรีเฟรชหน้านี้</p>
          {attempts >= SLOW_QUEUE_ATTEMPTS && (
            <p className="fine-print">ตอนนี้มีคนจองพร้อมกันจำนวนมาก ไม่ต้องกดจองซ้ำ หน้านี้จะอัปเดตเอง</p>
          )}
        </div>
      )}

      {status === 'PENDING' && (
        <div className="timer-bar">
          <span>กรุณาชำระเงินภายใน</span>
          <Countdown until={booking.expiresAt} onExpire={refresh} />
        </div>
      )}
      {status === 'CONFIRMED' && (
        <p className="banner banner-success">
          <Icon name="check" />
          ชำระเงินเรียบร้อย บัตรของคุณได้รับการยืนยันแล้ว
        </p>
      )}
      {status === 'EXPIRED' && <p className="banner banner-info">หมดเวลาชำระเงิน ที่นั่งถูกคืนให้ผู้อื่นแล้ว</p>}
      {status === 'FAILED' && (
        <p className="banner banner-error">{FAIL_REASONS[booking.failReason] || 'จองไม่สำเร็จ'}</p>
      )}

      {status !== 'QUEUED' && (
        <article className={`ticket ticket-${status.toLowerCase()}`}>
          <div className="ticket-main">
            <Poster event={{ id: booking.eventId, name: booking.eventName, startsAt: event?.startsAt }} variant="thumb" />
            <div className="ticket-info">
              <StatusBadge status={status} />
              <h1>{booking.eventName}</h1>
              {event && (
                <ul className="meta">
                  <li>
                    <Icon name="calendar" size={16} />
                    {formatDate(event.startsAt)} · {formatTime(event.startsAt)}
                  </li>
                  <li>
                    <Icon name="pin" size={16} />
                    {event.venue}
                  </li>
                </ul>
              )}
            </div>
          </div>
          <dl className="ticket-stub">
            <div>
              <dt>โซน</dt>
              <dd>{booking.zoneName}</dd>
            </div>
            <div>
              <dt>จำนวน</dt>
              <dd>{booking.quantity} ใบ</dd>
            </div>
            {zone && (
              <div>
                <dt>ยอดชำระ</dt>
                <dd>{formatPrice(zone.price * booking.quantity)}</dd>
              </div>
            )}
            <div>
              <dt>จองเมื่อ</dt>
              <dd>{formatDateTime(booking.createdAt)}</dd>
            </div>
          </dl>
          <p className="ticket-ref">เลขที่การจอง {booking.bookingId}</p>
        </article>
      )}

      {status === 'PENDING' && (
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={handlePay} disabled={paying}>
          {paying ? 'กำลังชำระเงิน…' : 'ชำระเงิน (จำลอง)'}
        </button>
      )}

      <ErrorBanner message={payError || error} />

      <div className="link-row">
        <Link to="/me/bookings" className="btn btn-outline">
          บัตรของฉัน
        </Link>
        {booking.eventId && (
          <Link to={`/events/${booking.eventId}`} className="btn btn-outline">
            กลับไปหน้าอีเวนต์
          </Link>
        )}
      </div>
    </section>
  );
}
