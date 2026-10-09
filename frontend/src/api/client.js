const BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');

// Every backend error has the shape { error: "<code>", message: "<text>" }; keep both so pages can branch on
// the code and fall back to the text.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function request(path, { method = 'GET', body, token, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Network error');
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || 'http_error', data?.message || res.statusText);
  }
  return data;
}

const MESSAGES = {
  network_error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง',
  invalid_credentials: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  username_taken: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว',
  unauthorized: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  forbidden: 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้',
  event_not_found: 'ไม่พบอีเวนต์นี้',
  zone_not_found: 'ไม่พบโซนนี้ในอีเวนต์',
  sale_not_open: 'ยังไม่เปิดขาย',
  sale_closed: 'อีเวนต์เริ่มแล้ว ปิดการขาย',
  queue_unavailable: 'ระบบรับคำขอไม่ได้ชั่วคราว กดจองอีกครั้งได้เลย',
  booking_not_payable: 'ชำระเงินไม่ได้ การจองนี้หมดเวลาหรือไม่อยู่ในสถานะรอชำระ',
  event_has_bookings: 'ลบไม่ได้ เพราะงานนี้มีการจองแล้ว',
  zone_has_bookings: 'ลบไม่ได้ เพราะโซนนี้มีการจองแล้ว',
  capacity_below_reserved: 'ลดความจุต่ำกว่าจำนวนที่นั่งที่จองไปแล้วไม่ได้',
  zone_name_taken: 'มีโซนชื่อนี้ในงานนี้แล้ว',
  invalid_schedule: 'วันเปิดขายต้องไม่เลยวันแสดง',
  internal_error: 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง',
};

export function errorMessage(err) {
  if (err instanceof ApiError) {
    if (err.code === 'validation_error') return `ข้อมูลไม่ถูกต้อง: ${err.message}`;
    return MESSAGES[err.code] || err.message;
  }
  return 'เกิดข้อผิดพลาดที่ไม่คาดคิด';
}
