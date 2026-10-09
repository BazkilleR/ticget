import { NavLink, Outlet } from 'react-router';

// Shared frame for every /admin page: title and the admin section's own menu.
export default function AdminLayout() {
  return (
    <section className="wrap section">
      <h1 className="section-title">ผู้ดูแลระบบ</h1>
      <nav className="admin-nav" aria-label="เมนูผู้ดูแลระบบ">
        <NavLink to="/admin" end>
          ภาพรวม
        </NavLink>
        <NavLink to="/admin/events">งานแสดง</NavLink>
      </nav>
      <Outlet />
    </section>
  );
}
