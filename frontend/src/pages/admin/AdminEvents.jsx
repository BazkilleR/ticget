import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { useApi } from '../../auth/AuthContext';
import { ErrorBanner, Icon, Spinner } from '../../components/common';
import { SaleChip } from '../../components/EventCard';
import { SoldBar, SoldLegend } from '../../components/charts';
import { formatDateTime } from '../../format';

export default function AdminEvents() {
  const api = useApi();
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [includePast, setIncludePast] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api(`/admin/events${includePast ? '?include=past' : ''}`, { signal: controller.signal })
      .then(setEvents)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [api, includePast]);

  return (
    <>
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
          รวมงานที่เริ่มไปแล้ว
        </label>
        <Link to="/admin/events/new" className="btn btn-primary">
          <Icon name="plus" size={16} />
          สร้างงานแสดง
        </Link>
      </div>

      <ErrorBanner message={error} />
      {!events && !error && <Spinner />}
      {events?.length === 0 && <p className="empty">ยังไม่มีงานแสดง</p>}
      {events?.length > 0 && <SoldLegend />}
      {events?.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>งานแสดง</th>
                <th>วันแสดง</th>
                <th>การขาย</th>
                <th className="num">โซน</th>
                <th>ขายแล้ว / ความจุ</th>
                <th className="num">รอชำระ</th>
                <th aria-label="จัดการ" />
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const started = new Date(event.startsAt) <= new Date();
                return (
                  <tr key={event.id} className={started ? 'row-muted' : undefined}>
                    <td>
                      <Link to={`/admin/events/${event.id}`} className="table-title">
                        {event.name}
                      </Link>
                      <span className="table-sub">{event.venue}</span>
                    </td>
                    <td className="nowrap">{formatDateTime(event.startsAt)}</td>
                    <td>{started ? <span className="chip chip-ended">จบแล้ว</span> : <SaleChip event={event} />}</td>
                    <td className="num">{event.zoneCount}</td>
                    <td>
                      <SoldBar sold={event.sold} held={event.held} capacity={event.capacity} />
                    </td>
                    <td className="num">{event.held.toLocaleString('th-TH')}</td>
                    <td>
                      <Link to={`/admin/events/${event.id}`} className="btn btn-outline btn-sm">
                        จัดการ
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
