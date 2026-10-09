import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// The QR holds a link to the admin check-in page, so door staff can scan it with any phone camera and
// land on the page with the code filled in. The code alone is what matters; the origin is just convenience.
export function checkInUrl(code) {
  return `${window.location.origin}/admin/check-in?code=${code}`;
}

// Shown under the QR for typing in by hand: 8 groups of 4 characters.
export const groupCode = (code) => code.match(/.{1,4}/g).join(' ');

export default function TicketQr({ code, size = 168 }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(checkInUrl(code), { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [code, size]);

  return (
    <div className="ticket-qr" style={{ width: size, height: size }}>
      {src && <img src={src} width={size} height={size} alt="QR code สำหรับสแกนเข้างาน" />}
    </div>
  );
}
