import { useState } from 'react';
import { downloadFile, errorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBanner, Icon } from '../../components/common';

// CSV export of confirmed bookings. Its own panel with its own filters, because they only scope the file,
// not the charts on the page.
export default function SalesReport({ events, eventId: fixedEventId }) {
  const { token } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [eventId, setEventId] = useState(fixedEventId ? String(fixedEventId) : '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleDownload(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const query = new URLSearchParams(Object.entries({ from, to, eventId }).filter(([, v]) => v));
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      await downloadFile(`/admin/reports/sales.csv?${query}`, {
        token,
        filename: `sales${eventId ? `-event-${eventId}` : ''}-${stamp}.csv`,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel report-form" onSubmit={handleDownload}>
      <h2 className="panel-title">รายงานยอดขาย (CSV)</h2>
      <p className="fine-print">รายการที่ชำระเงินแล้ว เปิดด้วย Excel หรือ Google Sheets ได้ วันที่เป็นวันชำระเงินตามเวลาไทย</p>
      <div className="filter-row">
        <label className="field">
          <span>ชำระตั้งแต่วันที่</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>ถึงวันที่</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {!fixedEventId && (
          <label className="field">
            <span>งานแสดง</span>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">ทุกงาน</option>
              {events?.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ErrorBanner message={error} />
      <div>
        <button type="submit" className="btn btn-outline" disabled={busy}>
          <Icon name="download" size={16} />
          {busy ? 'กำลังเตรียมไฟล์…' : 'ดาวน์โหลด CSV'}
        </button>
      </div>
    </form>
  );
}
