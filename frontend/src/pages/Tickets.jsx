import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/client';
import { useApi } from '../auth/AuthContext';
import { ErrorBanner, Icon, Poster, Spinner } from '../components/common';
import TicketQr, { groupCode } from '../components/TicketQr';
import { formatDate, formatDateTime, formatTime } from '../format';

function ETicket({ data, ticket }) {
  const used = Boolean(ticket.checkedInAt);
  return (
    <article className={`eticket${used ? ' eticket-used' : ''}`}>
      <header className="eticket-head">
        <Poster event={{ id: data.event.id, name: data.event.name }} variant="mini" />
        <div>
          <h2>{data.event.name}</h2>
          <p>
            ใบที่ {ticket.seq} / {data.quantity}
          </p>
        </div>
      </header>
      <div className="eticket-body">
        <dl className="eticket-details">
          <div>
            <dt>วันที่</dt>
            <dd>{formatDate(data.event.startsAt)}</dd>
          </div>
          <div>
            <dt>เวลา</dt>
            <dd>{formatTime(data.event.startsAt)}</dd>
          </div>
          <div className="span-2">
            <dt>สถานที่</dt>
            <dd>{data.event.venue}</dd>
          </div>
          <div>
            <dt>โซน</dt>
            <dd>{data.zone.name}</dd>
          </div>
          <div>
            <dt>สถานะ</dt>
            <dd>{used ? 'ใช้เข้างานแล้ว' : 'ใช้ได้'}</dd>
          </div>
        </dl>
        <div className="eticket-qr">
          <TicketQr code={ticket.code} />
          <code>{groupCode(ticket.code)}</code>
        </div>
      </div>
      {used && <p className="eticket-stamp">ใช้แล้ว {formatDateTime(ticket.checkedInAt)}</p>}
    </article>
  );
}

export default function Tickets() {
  const { id } = useParams();
  const api = useApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api(`/bookings/${id}/tickets`, { signal: controller.signal })
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [api, id]);

  return (
    <section className="wrap section narrow">
      <div className="toolbar no-print">
        <Link to={`/bookings/${id}`} className="back-link back-link-dark">
          <Icon name="back" size={16} />
          รายละเอียดการจอง
        </Link>
        {data?.tickets.length > 0 && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => window.print()}>
            พิมพ์บัตร
          </button>
        )}
      </div>
      <h1 className="section-title no-print">e-Ticket</h1>

      <ErrorBanner message={error} />
      {!data && !error && <Spinner />}
      {data && data.tickets.length === 0 && (
        <div className="empty">
          <p>ยังไม่มี e-Ticket บัตรจะออกให้หลังชำระเงินเรียบร้อย</p>
          <Link to={`/bookings/${id}`} className="btn btn-primary">
            ไปหน้าชำระเงิน
          </Link>
        </div>
      )}
      {data?.tickets.length > 0 && (
        <>
          <p className="fine-print no-print">แสดง QR code ที่หน้างาน 1 ใบต่อ 1 ท่าน · ห้ามเผยแพร่ภาพบัตร ใครสแกนก่อนจะเข้างานได้ก่อน</p>
          <div className="eticket-list">
            {data.tickets.map((ticket) => (
              <ETicket key={ticket.ticketId} data={data} ticket={ticket} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
