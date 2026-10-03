import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { useApi } from '../auth/AuthContext';
import { Countdown, ErrorBanner, Spinner, StatusBadge } from '../components/common';
import { FAIL_REASONS, formatDateTime } from '../format';

// The worker usually picks a booking up within a second or two; back off if the queue is busy.
const pollDelay = (attempt) => (attempt < 5 ? 1000 : attempt < 15 ? 2000 : 3000);
const SLOW_QUEUE_ATTEMPTS = 20;

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
      <section className="card booking-card">
        <ErrorBanner message={error} />
        {!error && <Spinner />}
      </section>
    );
  }

  return (
    <section className="card booking-card">
      <div className="booking-head">
        <h1>สถานะการจอง</h1>
        <StatusBadge status={booking.status} />
      </div>

      {booking.status === 'QUEUED' ? (
        <div className="queued">
          <div className="pulse" aria-hidden="true" />
          <p>คำขอของคุณอยู่ในคิว ระบบกำลังตรวจสอบที่นั่ง…</p>
          {attempts >= SLOW_QUEUE_ATTEMPTS && (
            <p className="muted small">ตอนนี้มีคนจองพร้อมกันจำนวนมาก ไม่ต้องกดจองซ้ำ หน้านี้จะอัปเดตเอง</p>
          )}
        </div>
      ) : (
        <dl className="details">
          <dt>อีเวนต์</dt>
          <dd>{booking.eventName}</dd>
          <dt>โซน</dt>
          <dd>{booking.zoneName}</dd>
          <dt>จำนวน</dt>
          <dd>{booking.quantity} ใบ</dd>
          <dt>จองเมื่อ</dt>
          <dd>{formatDateTime(booking.createdAt)}</dd>
        </dl>
      )}

      {booking.status === 'PENDING' && (
        <div className="pay-box">
          <p>
            ชำระเงินภายใน <Countdown until={booking.expiresAt} onExpire={refresh} />
          </p>
          <button type="button" className="button" onClick={handlePay} disabled={paying}>
            {paying ? 'กำลังชำระเงิน…' : 'ชำระเงิน (จำลอง)'}
          </button>
        </div>
      )}
      {booking.status === 'CONFIRMED' && <p className="banner banner-success">ชำระเงินเรียบร้อย ตั๋วของคุณได้รับการยืนยันแล้ว</p>}
      {booking.status === 'EXPIRED' && <p className="banner banner-info">หมดเวลาชำระเงิน ที่นั่งถูกคืนให้ผู้อื่นแล้ว</p>}
      {booking.status === 'FAILED' && (
        <p className="banner banner-error">{FAIL_REASONS[booking.failReason] || 'จองไม่สำเร็จ'}</p>
      )}

      <ErrorBanner message={payError || error} />

      <p className="muted small">
        <Link to="/me/bookings">ดูการจองทั้งหมด</Link>
        {booking.eventId && (
          <>
            {' · '}
            <Link to={`/events/${booking.eventId}`}>กลับไปหน้าอีเวนต์</Link>
          </>
        )}
      </p>
    </section>
  );
}
