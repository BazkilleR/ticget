const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
const baht = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });

export const formatDateTime = (iso) => dateTime.format(new Date(iso));
export const formatPrice = (amount) => baht.format(amount);

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
