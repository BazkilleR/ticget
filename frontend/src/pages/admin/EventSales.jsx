import { useCallback, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useApi } from '../../auth/AuthContext';
import { ErrorBanner, Spinner } from '../../components/common';
import { SoldBar, SoldLegend, StatTile } from '../../components/charts';
import { formatPercent, formatPrice } from '../../format';
import { DailyChart, useAutoRefresh } from './AdminDashboard';
import SalesReport from './SalesReport';

const REFRESH_MS = 30_000;
const fmt = (n) => n.toLocaleString('th-TH');

export default function EventSales({ eventId }) {
  const api = useApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/admin/events/${eventId}/sales`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api, eventId]);

  useAutoRefresh(load, REFRESH_MS);

  if (!data) return error ? <ErrorBanner message={error} /> : <Spinner />;
  const { totals } = data;

  return (
    <div className="dashboard">
      <ErrorBanner message={error} />
      <div className="stat-grid">
        <StatTile label="รายได้" value={formatPrice(totals.revenue)} />
        <StatTile label="ขายแล้ว" value={`${fmt(totals.sold)} / ${fmt(totals.capacity)} ใบ`} note={`ขายได้ ${formatPercent(totals.sellThrough)}`} />
        <StatTile label="รอชำระเงิน" value={`${fmt(totals.held)} ใบ`} />
        <StatTile label="ที่นั่งว่าง" value={`${fmt(totals.capacity - totals.sold - totals.held)} ใบ`} />
      </div>

      <div className="panel">
        <h2 className="panel-title">ยอดขายรายวัน</h2>
        <DailyChart daily={data.daily} />
      </div>

      <div className="panel">
        <h2 className="panel-title">ยอดขายแยกตามโซน</h2>
        <SoldLegend />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>โซน</th>
                <th className="num">ราคา</th>
                <th>ขายแล้ว / ความจุ</th>
                <th className="num">รอชำระ</th>
                <th className="num">ว่าง</th>
                <th className="num">ขายได้</th>
                <th className="num">รายได้</th>
              </tr>
            </thead>
            <tbody>
              {data.zones.map((z) => (
                <tr key={z.zoneId}>
                  <td>{z.name}</td>
                  <td className="num">{formatPrice(z.price)}</td>
                  <td>
                    <SoldBar sold={z.sold} held={z.held} capacity={z.capacity} />
                  </td>
                  <td className="num">{fmt(z.held)}</td>
                  <td className="num">{fmt(z.available)}</td>
                  <td className="num">{formatPercent(z.sellThrough)}</td>
                  <td className="num">{formatPrice(z.revenue)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>รวม</th>
                <td />
                <td>
                  <SoldBar sold={totals.sold} held={totals.held} capacity={totals.capacity} />
                </td>
                <td className="num">{fmt(totals.held)}</td>
                <td className="num">{fmt(totals.capacity - totals.sold - totals.held)}</td>
                <td className="num">{formatPercent(totals.sellThrough)}</td>
                <td className="num">{formatPrice(totals.revenue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="fine-print">รายได้คิดจากราคา ณ ตอนที่จอง ถ้าแก้ราคาโซนภายหลัง ยอดเดิมไม่เปลี่ยน</p>
      </div>

      <SalesReport eventId={eventId} />
    </div>
  );
}
