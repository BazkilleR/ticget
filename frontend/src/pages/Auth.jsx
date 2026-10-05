import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { request, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../components/common';

function useAuthForm(onSubmit) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(username.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return { username, setUsername, password, setPassword, error, busy, handleSubmit };
}

function AuthCard({ form, submitLabel, returnTo, register = false }) {
  return (
    <section className="wrap section">
      <div className="auth-card">
        <nav className="auth-tabs">
          <Link to="/login" state={{ from: returnTo }} className={register ? '' : 'active'} replace>
            เข้าสู่ระบบ
          </Link>
          <Link to="/register" state={{ from: returnTo }} className={register ? 'active' : ''} replace>
            สมัครสมาชิก
          </Link>
        </nav>
        <form onSubmit={form.handleSubmit} className="auth-form">
          <h1 className="sr-only">{register ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</h1>
          <label className="field">
            <span>ชื่อผู้ใช้</span>
            <input
              name="username"
              autoComplete="username"
              required
              {...(register && { minLength: 3, maxLength: 32, pattern: '[A-Za-z0-9_.\\-]+' })}
              value={form.username}
              onChange={(e) => form.setUsername(e.target.value)}
            />
            {register && <small>3–32 ตัว ใช้ได้เฉพาะ a-z, 0-9, _ . -</small>}
          </label>
          <label className="field">
            <span>รหัสผ่าน</span>
            <input
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              {...(register && { minLength: 8 })}
              value={form.password}
              onChange={(e) => form.setPassword(e.target.value)}
            />
            {register && <small>อย่างน้อย 8 ตัวอักษร</small>}
          </label>
          <ErrorBanner message={form.error} />
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={form.busy}>
            {form.busy ? 'กำลังดำเนินการ…' : submitLabel}
          </button>
        </form>
      </div>
    </section>
  );
}

// Where to go after logging in: back to the page that sent the user here, or the event list.
function useReturnTo() {
  const location = useLocation();
  return location.state?.from || '/';
}

export function Login() {
  const { token, login } = useAuth();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const form = useAuthForm(async (username, password) => {
    await login(username, password);
    navigate(returnTo, { replace: true });
  });

  if (token) return <Navigate to={returnTo} replace />;
  return (
    <AuthCard form={form} submitLabel="เข้าสู่ระบบ" returnTo={returnTo} />
  );
}

export function Register() {
  const { token, login } = useAuth();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const form = useAuthForm(async (username, password) => {
    await request('/auth/register', { method: 'POST', body: { username, password } });
    await login(username, password);
    navigate(returnTo, { replace: true });
  });

  if (token) return <Navigate to={returnTo} replace />;
  return (
    <AuthCard register form={form} submitLabel="สมัครสมาชิก" returnTo={returnTo} />
  );
}
