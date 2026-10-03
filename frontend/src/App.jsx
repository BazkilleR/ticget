import { Link, NavLink, Route, Routes } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './components/common';
import { Login, Register } from './pages/Auth';
import Events from './pages/Events';
import EventZones from './pages/EventZones';
import BookingStatus from './pages/BookingStatus';
import MyBookings from './pages/MyBookings';

export default function App() {
  const { username, logout } = useAuth();

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <img src="/ticket.svg" alt="" width="24" height="24" />
            Ticket Booking
          </Link>
          <nav className="nav">
            <NavLink to="/" end>
              อีเวนต์
            </NavLink>
            {username ? (
              <>
                <NavLink to="/me/bookings">การจองของฉัน</NavLink>
                <span className="muted user">{username}</span>
                <button type="button" className="link-button" onClick={logout}>
                  ออกจากระบบ
                </button>
              </>
            ) : (
              <NavLink to="/login">เข้าสู่ระบบ</NavLink>
            )}
          </nav>
        </div>
      </header>

      <main className="container">
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
            path="*"
            element={
              <section className="empty">
                <h1>ไม่พบหน้านี้</h1>
                <Link to="/">กลับหน้าแรก</Link>
              </section>
            }
          />
        </Routes>
      </main>
    </>
  );
}
