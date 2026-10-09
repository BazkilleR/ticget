import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { useApi } from '../../auth/AuthContext';
import { ErrorBanner, Icon, Spinner, StatusBadge } from '../../components/common';
import { BarChart, SoldBar, StatTile } from '../../components/charts';
import { FAIL_REASONS, formatDateTime, formatDay, formatPrice, formatTime } from '../../format';
import SalesReport from './SalesReport';

const REFRESH_MS = 30_000;
const fmt = (n) => n.toLocaleString('th-TH');

const METRICS = {
  revenue: { label: 'รายได้', name: 'รายได้ (บาท)', format: formatPrice },
  tickets: { label: 'จำนวนบัตร', name: 'บัตรที่ขาย', format: (n) => `${fmt(n)} ใบ` },
};

// Polls while the tab is visible; a hidden tab skips the tick instead of piling up requests.
export function useAutoRefresh(load, ms) {
  useEffect(() => {
    load();
    const timer = setInterval(() => !document.hidden && load(), ms);
    return () => clearInterval(timer);
  }, [load, ms]);
}

export function DailyChart({ daily }) {
  const [metric, setMetric] = useState('revenue');
  const { name, format } = METRICS[metric];
  return (
    <>
      <div className="segmented" role="group" aria-label="แสดงเป็น">
        {Object.entries(METRICS).map(([key, m]) => (
          <button
            key={key}
            type="button"
            className={metric === key ? 'active' : undefined}
            aria-pressed={metric === key}
            onClick={() => setMetric(key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <BarChart
        name={name}
        formatValue={format}
        data={daily.map((d) => ({ key: d.date, label: formatDay(d.date), value: d[metric] }))}
      />
    </>
  );
}

export default function AdminDashboard() {
  const api = useApi();
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api('/admin/dashboard'));
      setUpdatedAt(new Date());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useAutoRefresh(load, REFRESH_MS);

  useEffect(() => {
    api('/admin/events?include=past').then(setEvents).catch(() => {});
  }, [api]);

  if (!data) return error ? <ErrorBanner message={error} /> : <Spinner />;

  const statuses = Object.entries(data.bookingsByStatus);
  const totalBookings = statuses.reduce((sum, [, n]) => sum + n, 0);

  return (
    // Refetching keeps the current numbers on screen, just dimmed, so nothing jumps.
    <div className={`dashboard${loading ? ' is-refreshing' : ''}`}>
      <div className="toolbar">
        <span className="fine-print">
          {updatedAt && `อัปเดตล่าสุด ${formatTime(updatedAt)} · รีเฟรชอัตโนมัติทุก 30 วินาที`}
        </span>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
          <Icon name="refresh" size={16} />
          รีเฟรช
        </button>
      </div>
      <ErrorBanner message={error} />

      <div className="stat-grid">
        <StatTile label="รายได้รวม" value={formatPrice(data.revenue)} note="จากการจองที่ชำระเงินแล้ว" />
        <StatTile label="บัตรที่ขายแล้ว" value={`${fmt(data.ticketsSold)} ใบ`} />
        <StatTile label="รอชำระเงิน" value={`${fmt(data.ticketsHeld)} ใบ`} note="ถือที่นั่งไว้ไม่เกิน 10 นาที" />
        <StatTile label="งานที่กำลังจะมาถึง" value={`${fmt(data.upcomingEvents)} งาน`} />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">ยอดขาย 14 วันล่าสุด</h2>
        </div>
        <DailyChart daily={data.daily} />
      </div>

      <div className="dash-grid">
        <div className="panel">
          <h2 className="panel-title">งานขายดี</h2>
          {data.topEvents.length === 0 ? (
            <p className="empty">ยังไม่มียอดขาย</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>งานแสดง</th>
                    <th>ขายแล้ว / ความจุ</th>
                    <th className="num">รายได้</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topEvents.map((e) => (
                    <tr key={e.eventId}>
                      <td>
                        <Link to={`/admin/events/${e.eventId}?tab=sales`} className="table-title">
                          {e.name}
                        </Link>
                        <span className="table-sub">{formatDateTime(e.startsAt)}</span>
                      </td>
                      <td>
                        <SoldBar sold={e.ticketsSold} held={0} capacity={e.capacity} />
                      </td>
                      <td className="num">{formatPrice(e.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <h2 className="panel-title">สถานะการจอง</h2>
          <table className="table table-compact">
            <tbody>
              {statuses.map(([status, n]) => (
                <tr key={status}>
                  <td>
                    <StatusBadge status={status} />
                  </td>
                  <td className="num">{fmt(n)}</td>
                  <td className="num muted">{totalBookings ? `${Math.round((n / totalBookings) * 100)}%` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="sub-title">เหตุผลที่จองไม่สำเร็จ</h3>
          <table className="table table-compact">
            <tbody>
              {Object.entries(data.failReasons).map(([reason, n]) => (
                <tr key={reason}>
                  <td>{FAIL_REASONS[reason]}</td>
                  <td className="num">{fmt(n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2 className="panel-title">รายการขายล่าสุด</h2>
        {data.recentSales.length === 0 ? (
          <p className="empty">ยังไม่มีรายการ</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ชำระเมื่อ</th>
                  <th>ผู้ซื้อ</th>
                  <th>งานแสดง</th>
                  <th>โซน</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ยอดชำระ</th>
                </tr>
              </thead>
              <tbody>
                {data.recentSales.map((s) => (
                  <tr key={s.bookingId}>
                    <td className="nowrap">{formatDateTime(s.paidAt)}</td>
                    <td>{s.username}</td>
                    <td>{s.eventName}</td>
                    <td>{s.zoneName}</td>
                    <td className="num">{s.quantity}</td>
                    <td className="num">{formatPrice(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SalesReport events={events} />
    </div>
  );
}
