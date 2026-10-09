import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthContext';

// Overview tab. The sales dashboard replaces this in a later phase.
export default function AdminHome() {
  const { username } = useAuth();
  return (
    <div className="panel">
      <p>สวัสดี {username}</p>
      <p className="fine-print">แดชบอร์ดยอดขายจะแสดงที่หน้านี้</p>
      <Link to="/admin/events" className="btn btn-primary">
        จัดการงานแสดง
      </Link>
    </div>
  );
}
