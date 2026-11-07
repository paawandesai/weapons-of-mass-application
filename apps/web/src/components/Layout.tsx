import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';

export function Layout() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [unauth, setUnauth] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .me()
      .then((m) => {
        if (!live) return;
        setEmail(m.user.email);
        setDemo(m.demo === true);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) setUnauth(true);
        else setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (unauth) return <Navigate to="/signin" replace />;
  if (failed)
    return (
      <p role="alert" className="banner error">
        We could not load your account. Reload the page to try again.
      </p>
    );
  if (email === null) return <p className="muted pad">Loading…</p>;

  async function signOut() {
    try {
      await api.signOut();
    } finally {
      navigate('/signin');
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <strong>Weapons of Mass Application</strong>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/board">Board</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/survey">Survey</NavLink>
          <NavLink to="/profile/review">Profile review</NavLink>
          {demo && <NavLink to="/demo/inbox">Inbox</NavLink>}
        </nav>
        <span className="spacer" />
        <span className="muted">{email}</span>
        <button type="button" className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
