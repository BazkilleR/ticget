import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { useApi } from '../../auth/AuthContext';
import { ErrorBanner, Icon, Spinner } from '../../components/common';
import { groupCode } from '../../components/TicketQr';
import { formatDateTime } from '../../format';

const GATE_EVENT_KEY = 'ticket.checkin.eventId';
const DAY_MS = 86_400_000;

// The gate's event is remembered per browser so staff pick it once per shift. Storage may be unavailable.
function savedEventId() {
  try {
    return Number(localStorage.getItem(GATE_EVENT_KEY)) || null;
  } catch {
    return null;
  }
}

function saveEventId(id) {
  try {
    localStorage.setItem(GATE_EVENT_KEY, String(id));
  } catch {
    // ignore: the choice just will not survive a reload
  }
}

// Spaces, dashes and case do not matter when typing a code from a printed ticket.
const normalize = (code) => code.replace(/[\s-]/g, '').toLowerCase();

export default function AdminCheckIn() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState(null);
  const [eventId, setEventId] = useState(savedEventId);
  const [codeInput, setCodeInput] = useState('');
  const [ticket, setTicket] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const scanned = params.get('code');

  // Shows that are on today or later. Started ones count: the doors are open while the show runs.
  useEffect(() => {
    api('/admin/events?include=past')
      .then((list) => {
        const current = list.filter((e) => new Date(e.startsAt).getTime() > Date.now() - DAY_MS);
        setEvents(current);
        setEventId((id) => (current.some((e) => e.id === id) ? id : current[0]?.id ?? null));
      })
      .catch((err) => setError(errorMessage(err)));
  }, [api]);

  async function lookUp(code) {
    setBusy(true);
    setError(null);
    setResult(null);
    setTicket(null);
    try {
      setTicket(await api(`/admin/tickets/${encodeURIComponent(code)}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Opened from a scanned QR: look the ticket up straight away, then drop the code from the URL so a
  // reload does not bring it back.
  useEffect(() => {
    if (!scanned) return;
    lookUp(normalize(scanned));
    setParams({}, { replace: true });
  }, [scanned]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const done = await api('/admin/tickets/check-in', { method: 'POST', body: { code: ticket.code, eventId } });
      setResult(done);
      setTicket(null);
      setCodeInput('');
    } catch (err) {
      setError(errorMessage(err));
      // Show the latest state (e.g. the time it was already used).
      api(`/admin/tickets/${ticket.code}`).then(setTicket).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function handleManual(e) {
    e.preventDefault();
    const code = normalize(codeInput);
    if (code) lookUp(code);
  }

  function chooseEvent(id) {
    setEventId(id);
    saveEventId(id);
    setResult(null);
  }

  if (!events && !error) return <Spinner />;

  const gateEvent = events?.find((e) => e.id === eventId);
  const wrongEvent = ticket && gateEvent && ticket.eventId !== gateEvent.id;

  return (
    <div className="checkin">
      <div className="panel">
        <label className="field">
          <span>ตรวจบัตรสำหรับงาน</span>
          <select value={eventId ?? ''} onChange={(e) => chooseEvent(Number(e.target.value))}>
            {events?.length === 0 && <option value="">ไม่มีงานที่กำลังจะเริ่ม</option>}
            {events?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {formatDateTime(e.startsAt)}
              </option>
            ))}
          </select>
        </label>

        <form className="checkin-manual" onSubmit={handleManual}>
          <label className="field">
            <span>รหัสบัตร</span>
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="รหัส 32 ตัวใต้ QR"
              autoComplete="off"
              spellCheck={false}
            />
            <small>หรือสแกน QR บนบัตรด้วยกล้องมือถือ ระบบจะเปิดหน้านี้พร้อมรหัสให้เอง</small>
          </label>
          <button type="submit" className="btn btn-outline" disabled={busy || !codeInput.trim()}>
            <Icon name="search" size={16} />
            ค้นหาบัตร
          </button>
        </form>
      </div>

      {result && (
        <div className="checkin-result checkin-ok" role="status">
          <Icon name="check" size={28} />
          <div>
            <strong>เข้างานได้</strong>
            <span>
              {result.username} · โซน {result.zoneName} · ใบที่ {result.seq}/{result.quantity}
            </span>
          </div>
        </div>
      )}
      <ErrorBanner message={error} />

      {ticket && (
        <div className="panel checkin-ticket">
          <h2 className="panel-title">{ticket.eventName}</h2>
          <dl className="eticket-details">
            <div>
              <dt>ผู้จอง</dt>
              <dd>{ticket.username}</dd>
            </div>
            <div>
              <dt>โซน</dt>
              <dd>{ticket.zoneName}</dd>
            </div>
            <div>
              <dt>ใบที่</dt>
              <dd>
                {ticket.seq} / {ticket.quantity}
              </dd>
            </div>
            <div>
              <dt>สถานะ</dt>
              <dd>{ticket.checkedInAt ? `ใช้แล้ว ${formatDateTime(ticket.checkedInAt)}` : 'ยังไม่ได้ใช้'}</dd>
            </div>
          </dl>
          <code className="checkin-code">{groupCode(ticket.code)}</code>
          {wrongEvent && <p className="banner banner-error">บัตรนี้เป็นของงานอื่น ไม่ใช่ {gateEvent.name}</p>}
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={busy || !eventId || Boolean(ticket.checkedInAt) || wrongEvent}
            onClick={confirm}
          >
            {busy ? 'กำลังบันทึก…' : 'ยืนยันเข้างาน'}
          </button>
        </div>
      )}
    </div>
  );
}
