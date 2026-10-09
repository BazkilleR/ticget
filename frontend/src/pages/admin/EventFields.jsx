import { fromBangkokInput, toBangkokInput } from '../../format';

// Form state keeps raw input strings; these convert to and from the API's shape.
export function eventToForm(event = {}) {
  return {
    name: event.name ?? '',
    venue: event.venue ?? '',
    description: event.description ?? '',
    startsAt: toBangkokInput(event.startsAt),
    saleOpensAt: toBangkokInput(event.saleOpensAt),
  };
}

export function formToEvent(form) {
  return {
    name: form.name,
    venue: form.venue,
    description: form.description,
    startsAt: fromBangkokInput(form.startsAt),
    saleOpensAt: fromBangkokInput(form.saleOpensAt),
  };
}

export default function EventFields({ form, onChange }) {
  const field = (key) => ({ value: form[key], onChange: (e) => onChange({ ...form, [key]: e.target.value }) });
  return (
    <div className="form-grid">
      <label className="field span-2">
        <span>ชื่องานแสดง</span>
        <input required maxLength={200} {...field('name')} />
      </label>
      <label className="field span-2">
        <span>สถานที่</span>
        <input required maxLength={200} {...field('venue')} />
      </label>
      <label className="field">
        <span>วันเวลาแสดง</span>
        <input type="datetime-local" required {...field('startsAt')} />
        <small>เวลาประเทศไทย</small>
      </label>
      <label className="field">
        <span>เปิดขายบัตร</span>
        <input type="datetime-local" required max={form.startsAt || undefined} {...field('saleOpensAt')} />
        <small>ต้องไม่เลยวันแสดง</small>
      </label>
      <label className="field span-2">
        <span>รายละเอียดงาน</span>
        <textarea rows={4} maxLength={2000} {...field('description')} />
        <small>ไม่บังคับ · ขึ้นบรรทัดใหม่ได้</small>
      </label>
    </div>
  );
}
