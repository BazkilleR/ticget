const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
const dateLong = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' });
const dayOfMonth = new Intl.DateTimeFormat('th-TH', { day: 'numeric' });
const monthShort = new Intl.DateTimeFormat('th-TH', { month: 'short' });
const baht = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });

export const formatDateTime = (iso) => dateTime.format(new Date(iso));
export const formatDate = (iso) => dateLong.format(new Date(iso));
export const formatTime = (iso) => `${time.format(new Date(iso))} น.`;
export const formatPrice = (amount) => baht.format(amount);
export const dateParts = (iso) => {
  const d = new Date(iso);
  return { day: dayOfMonth.format(d), month: monthShort.format(d) };
};

export const isSaleOpen = (event) => new Date(event.saleOpensAt) <= new Date();

export const STATUS_LABELS = {
  QUEUED: 'อยู่ในคิว',
  PENDING: 'รอชำระเงิน',
  CONFIRMED: 'ชำระเงินแล้ว',
  EXPIRED: 'หมดเวลา',
  FAILED: 'จองไม่สำเร็จ',
};

export const FAIL_REASONS = {
  SOLD_OUT: 'ที่นั่งในโซนนี้เต็มแล้ว',
  USER_LIMIT: 'เกินจำนวนสูงสุด 4 ใบต่อคนต่ออีเวนต์',
};
