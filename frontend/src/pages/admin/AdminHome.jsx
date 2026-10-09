import { useAuth } from '../../auth/AuthContext';

// Landing page for admins. Event management and the sales dashboard are added in the next phases.
export default function AdminHome() {
  const { username } = useAuth();
  return (
    <section className="wrap section">
      <h1 className="section-title">ผู้ดูแลระบบ</h1>
      <p className="empty">สวัสดี {username} — เมนูจัดการงานแสดงและรายงานยอดขายจะอยู่ที่หน้านี้</p>
    </section>
  );
}
