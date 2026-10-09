import { Link, NavLink, Route, Routes, useNavigate } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { AdminRoute, Icon, ProtectedRoute } from './components/common';
import { Login, Register } from './pages/Auth';
import Events from './pages/Events';
import EventZones from './pages/EventZones';
import BookingStatus from './pages/BookingStatus';
import MyBookings from './pages/MyBookings';
import Search from './pages/Search';
import Tickets from './pages/Tickets';
import AdminLayout from './pages/admin/AdminLayout';
import AdminHome from './pages/admin/AdminHome';
import AdminEvents from './pages/admin/AdminEvents';
import AdminEventNew from './pages/admin/AdminEventNew';
import AdminEventEdit from './pages/admin/AdminEventEdit';
import AdminCheckIn from './pages/admin/AdminCheckIn';

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

// Submitting opens the search page; the search page itself filters as you type.
function HeaderSearch() {
  const navigate = useNavigate();
  function handleSubmit(e) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q').trim();
    navigate(q ? `/search?${new URLSearchParams({ q })}` : '/search');
    e.currentTarget.reset();
  }
  return (
    <form className="header-search" role="search" onSubmit={handleSubmit}>
      <Icon name="search" size={16} />
      <input type="search" name="q" placeholder="ค้นหางานแสดง สถานที่" aria-label="ค้นหางานแสดง" maxLength={100} />
    </form>
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
            <HeaderSearch />
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
            <NavLink to="/search">ค้นหา</NavLink>
            <NavLink to="/me/bookings">บัตรของฉัน</NavLink>
            {isAdmin && <NavLink to="/admin">ผู้ดูแลระบบ</NavLink>}
          </div>
        </nav>
      </header>

      <main className="site-main">
        <Routes>
          <Route path="/" element={<Events />} />
          <Route path="/search" element={<Search />} />
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
            path="/bookings/:id/tickets"
            element={
              <ProtectedRoute>
                <Tickets />
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
                <AdminLayout />
              </AdminRoute>
            }
          >
            <Route index element={<AdminHome />} />
            <Route path="events" element={<AdminEvents />} />
            <Route path="events/new" element={<AdminEventNew />} />
            <Route path="events/:id" element={<AdminEventEdit />} />
            <Route path="check-in" element={<AdminCheckIn />} />
          </Route>
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
