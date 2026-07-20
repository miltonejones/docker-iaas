import { useState } from 'react';
import { useAuth } from '../AuthContext';

export function LoginPage() {
  const { login, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={submit}>
        <h2>Dockyard</h2>
        <p className="muted">{mode === 'login' ? 'Sign in to your account' : 'Create a new account'}</p>
        {error && <div className="login-form__error">{error}</div>}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
            minLength={8}
            required
          />
        </label>
        <button className="btn btn--primary login-form__submit" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <p className="login-form__switch">
          {mode === 'login' ? (
            <>No account? <button type="button" className="btn-link" onClick={() => { setMode('register'); setError(null); }}>Create one</button></>
          ) : (
            <>Already have an account? <button type="button" className="btn-link" onClick={() => { setMode('login'); setError(null); }}>Sign in</button></>
          )}
        </p>
      </form>
    </div>
  );
}
