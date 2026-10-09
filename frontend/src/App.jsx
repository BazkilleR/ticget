import { Link, NavLink, Route, Routes } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { AdminRoute, Icon, ProtectedRoute } from './components/common';
import { Login, Register } from './pages/Auth';
import Events from './pages/Events';
import EventZones from './pages/EventZones';
import BookingStatus from './pages/BookingStatus';
import MyBookings from './pages/MyBookings';
import AdminHome from './pages/admin/AdminHome';

function Logo() {
  return (
    <Link to="/" className="brand" aria-label="Ticket Booking หน้าแรก">
      <span className="brand-mark">
        <Icon name="ticket" size={20} />
      </span>
      <span className="brand-text">
        TICKET<b>BOOKING</b>
      </span>
    </Link>
  );
}

export default function App() {
  const { username, isAdmin, logout } = useAuth();

  return (
    <div className="page">
      <header className="site-header">
        <div className="topbar">
          <div className="wrap topbar-inner">
            <Logo />
            <div className="account">
              {username ? (
                <>
                  <span className="account-name">
                    <Icon name="user" size={16} />
                    {username}
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                    <Icon name="logout" size={16} />
                    ออกจากระบบ
                  </button>
                </>
              ) : (
                <>
                  <Link to="/login" className="btn btn-ghost btn-sm">
                    เข้าสู่ระบบ
                  </Link>
                  <Link to="/register" className="btn btn-primary btn-sm">
                    สมัครสมาชิก
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
        <nav className="menubar" aria-label="เมนูหลัก">
          <div className="wrap menubar-inner">
            <NavLink to="/" end>
              หน้าแรก
            </NavLink>
            <NavLink to="/me/bookings">บัตรของฉัน</NavLink>
            {isAdmin && <NavLink to="/admin">ผู้ดูแลระบบ</NavLink>}
          </div>
        </nav>
      </header>

      <main className="site-main">
        <Routes>
          <Route path="/" element={<Events />} />
          <Route path="/events/:id" element={<EventZones />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route
            path="/bookings/:id"
            element={
              <ProtectedRoute>
                <BookingStatus />
              </ProtectedRoute>
            }
          />
          <Route
            path="/me/bookings"
            element={
              <ProtectedRoute>
                <MyBookings />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <AdminRoute>
                <AdminHome />
              </AdminRoute>
            }
          />
          <Route
            path="*"
            element={
              <section className="wrap empty">
                <h1>ไม่พบหน้านี้</h1>
                <Link to="/" className="btn btn-primary">
                  กลับหน้าแรก
                </Link>
              </section>
            }
          />
        </Routes>
      </main>

      <footer className="site-footer">
        <div className="wrap footer-inner">
          <Logo />
          <p>จำกัด 4 ใบต่อคนต่ออีเวนต์ · ชำระเงินภายใน 10 นาทีหลังจองสำเร็จ</p>
        </div>
      </footer>
    </div>
  );
}
