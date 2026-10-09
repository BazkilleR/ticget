import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { useApi } from '../../auth/AuthContext';
import { ErrorBanner, Icon } from '../../components/common';
import EventFields, { eventToForm, formToEvent } from './EventFields';

const MAX_ZONES = 10;
let nextKey = 0;
const emptyZone = () => ({ key: nextKey++, name: '', price: '', capacity: '' });

export default function AdminEventNew() {
  const api = useApi();
  const navigate = useNavigate();
  const [form, setForm] = useState(eventToForm);
  const [zones, setZones] = useState(() => [emptyZone()]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const updateZone = (key, field, value) =>
    setZones((list) => list.map((z) => (z.key === key ? { ...z, [field]: value } : z)));

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const event = await api('/admin/events', {
        method: 'POST',
        body: {
          ...formToEvent(form),
          zones: zones.map((z) => ({ name: z.name, price: Number(z.price), capacity: Number(z.capacity) })),
        },
      });
      navigate(`/admin/events/${event.id}`, { replace: true, state: { created: true } });
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form className="admin-form" onSubmit={handleSubmit}>
      <Link to="/admin/events" className="back-link back-link-dark">
        <Icon name="back" size={16} />
        งานแสดงทั้งหมด
      </Link>

      <div className="panel">
        <h2 className="panel-title">สร้างงานแสดง</h2>
        <EventFields form={form} onChange={setForm} />
      </div>

      <div className="panel">
        <h2 className="panel-title">โซนและราคา</h2>
        <div className="table-wrap">
          <table className="table table-form">
            <thead>
              <tr>
                <th>ชื่อโซน</th>
                <th>ราคา (บาท)</th>
                <th>ความจุ (ที่นั่ง)</th>
                <th aria-label="ลบ" />
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.key}>
                  <td>
                    <input aria-label="ชื่อโซน" required maxLength={50} value={z.name} onChange={(e) => updateZone(z.key, 'name', e.target.value)} />
                  </td>
                  <td>
                    <input aria-label="ราคา" type="number" required min="0" max="1000000" value={z.price} onChange={(e) => updateZone(z.key, 'price', e.target.value)} />
                  </td>
                  <td>
                    <input aria-label="ความจุ" type="number" required min="1" max="100000" value={z.capacity} onChange={(e) => updateZone(z.key, 'capacity', e.target.value)} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost-dark btn-sm"
                      disabled={zones.length === 1}
                      onClick={() => setZones((list) => list.filter((x) => x.key !== z.key))}
                    >
                      ลบ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={zones.length >= MAX_ZONES}
          onClick={() => setZones((list) => [...list, emptyZone()])}
        >
          <Icon name="plus" size={16} />
          เพิ่มโซน
        </button>
      </div>

      <ErrorBanner message={error} />
      <div className="form-actions">
        <Link to="/admin/events" className="btn btn-outline">
          ยกเลิก
        </Link>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'กำลังบันทึก…' : 'สร้างงานแสดง'}
        </button>
      </div>
    </form>
  );
}
