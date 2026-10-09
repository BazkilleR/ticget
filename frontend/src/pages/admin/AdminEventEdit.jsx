import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { useApi } from '../../auth/AuthContext';
import { ErrorBanner, Icon, Spinner } from '../../components/common';
import { SoldBar } from './AdminEvents';
import EventFields, { eventToForm, formToEvent } from './EventFields';

const fmt = (n) => n.toLocaleString('th-TH');

// Only the fields that differ from what the server has, so a PATCH never rewrites untouched values.
function changedFields(next, original) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== original[key]));
}

function SuccessBanner({ message }) {
  if (!message) return null;
  return (
    <p className="banner banner-success" role="status">
      {message}
    </p>
  );
}

function ZoneRow({ zone, onSaved }) {
  const api = useApi();
  const [form, setForm] = useState({ name: zone.name, price: String(zone.price), capacity: String(zone.capacity) });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const patch = changedFields(
    { name: form.name.trim(), price: Number(form.price), capacity: Number(form.capacity) },
    zone,
  );
  const dirty = Object.keys(patch).length > 0;

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(() => api(`/admin/zones/${zone.zoneId}`, { method: 'PATCH', body: patch }));
  const remove = () => {
    if (!window.confirm(`ลบโซน "${zone.name}" ?`)) return;
    run(() => api(`/admin/zones/${zone.zoneId}`, { method: 'DELETE' }));
  };
  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });

  return (
    <>
      <tr>
        <td>
          <input aria-label="ชื่อโซน" maxLength={50} {...field('name')} />
        </td>
        <td>
          <input aria-label="ราคา" type="number" min="0" max="1000000" {...field('price')} />
        </td>
        <td>
          <input aria-label="ความจุ" type="number" min={Math.max(1, zone.reserved)} max="100000" {...field('capacity')} />
        </td>
        <td>
          <SoldBar sold={zone.sold} held={zone.held} capacity={zone.capacity} />
        </td>
        <td className="num">{fmt(zone.held)}</td>
        <td className="num">{fmt(zone.available)}</td>
        <td className="nowrap">
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>
            บันทึก
          </button>{' '}
          <button
            type="button"
            className="btn btn-ghost-dark btn-sm"
            disabled={busy || zone.bookingCount > 0}
            title={zone.bookingCount > 0 ? 'โซนที่มีการจองแล้วลบไม่ได้' : undefined}
            onClick={remove}
          >
            ลบ
          </button>
        </td>
      </tr>
      {error && (
        <tr className="row-error">
          <td colSpan={7}>
            <ErrorBanner message={error} />
          </td>
        </tr>
      )}
    </>
  );
}

function AddZone({ eventId, onSaved }) {
  const api = useApi();
  const empty = { name: '', price: '', capacity: '' };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/events/${eventId}/zones`, {
        method: 'POST',
        body: { name: form.name, price: Number(form.price), capacity: Number(form.capacity) },
      });
      setForm(empty);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-zone" onSubmit={handleSubmit}>
      <label className="field">
        <span>ชื่อโซนใหม่</span>
        <input required maxLength={50} {...field('name')} />
      </label>
      <label className="field">
        <span>ราคา (บาท)</span>
        <input type="number" required min="0" max="1000000" {...field('price')} />
      </label>
      <label className="field">
        <span>ความจุ</span>
        <input type="number" required min="1" max="100000" {...field('capacity')} />
      </label>
      <button type="submit" className="btn btn-outline" disabled={busy}>
        <Icon name="plus" size={16} />
        เพิ่มโซน
      </button>
      <ErrorBanner message={error} />
    </form>
  );
}

export default function AdminEventEdit() {
  const { id } = useParams();
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const [event, setEvent] = useState(null);
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState(location.state?.created ? 'สร้างงานแสดงแล้ว' : null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/admin/events/${id}`);
      setEvent(data);
      return data;
    } catch (err) {
      setLoadError(errorMessage(err));
      return null;
    }
  }, [api, id]);

  useEffect(() => {
    load().then((data) => data && setForm(eventToForm(data)));
  }, [load]);

  if (loadError) return <ErrorBanner message={loadError} />;
  if (!event || !form) return <Spinner />;

  const patch = changedFields(formToEvent(form), formToEvent(eventToForm(event)));
  const dirty = Object.keys(patch).length > 0;
  const hasBookings = event.zones.some((z) => z.bookingCount > 0);
  const totals = event.zones.reduce(
    (t, z) => ({ capacity: t.capacity + z.capacity, sold: t.sold + z.sold, held: t.held + z.held }),
    { capacity: 0, sold: 0, held: 0 },
  );

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const updated = await api(`/admin/events/${id}`, { method: 'PATCH', body: patch });
      setEvent(updated);
      setForm(eventToForm(updated));
      setNotice('บันทึกข้อมูลงานแล้ว');
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`ลบงาน "${event.name}" และโซนทั้งหมด? การลบย้อนกลับไม่ได้`)) return;
    try {
      await api(`/admin/events/${id}`, { method: 'DELETE' });
      navigate('/admin/events', { replace: true });
    } catch (err) {
      setSaveError(errorMessage(err));
    }
  }

  return (
    <div className="admin-form">
      <div className="toolbar">
        <Link to="/admin/events" className="back-link back-link-dark">
          <Icon name="back" size={16} />
          งานแสดงทั้งหมด
        </Link>
        <Link to={`/events/${event.id}`} className="btn btn-outline btn-sm">
          ดูหน้างานแสดง
        </Link>
      </div>

      <SuccessBanner message={notice} />

      <form className="panel" onSubmit={handleSave}>
        <h2 className="panel-title">ข้อมูลงาน</h2>
        <EventFields form={form} onChange={setForm} />
        <ErrorBanner message={saveError} />
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={hasBookings}
            title={hasBookings ? 'งานที่มีการจองแล้วลบไม่ได้' : undefined}
            onClick={handleDelete}
          >
            ลบงานแสดง
          </button>
          <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>
            {saving ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
        </div>
      </form>

      <div className="panel">
        <h2 className="panel-title">โซนและที่นั่ง</h2>
        <p className="fine-print">
          รวม {fmt(totals.capacity)} ที่นั่ง · ขายแล้ว {fmt(totals.sold)} · รอชำระ {fmt(totals.held)} · ราคาที่แก้มีผลกับการจองใหม่เท่านั้น
        </p>
        <div className="table-wrap">
          <table className="table table-form">
            <thead>
              <tr>
                <th>ชื่อโซน</th>
                <th>ราคา (บาท)</th>
                <th>ความจุ</th>
                <th>ขายแล้ว / ความจุ</th>
                <th className="num">รอชำระ</th>
                <th className="num">ว่าง</th>
                <th aria-label="จัดการ" />
              </tr>
            </thead>
            <tbody>
              {event.zones.map((zone) => (
                // Keyed on the saved values so the row's inputs reset to the server's state after a save.
                <ZoneRow key={`${zone.zoneId}:${zone.name}:${zone.price}:${zone.capacity}`} zone={zone} onSaved={load} />
              ))}
            </tbody>
          </table>
        </div>
        {event.zones.length === 0 && <p className="empty">ยังไม่มีโซน เพิ่มโซนด้านล่างเพื่อเปิดขาย</p>}
        <AddZone eventId={event.id} onSaved={load} />
      </div>
    </div>
  );
}
