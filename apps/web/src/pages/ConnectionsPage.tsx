import { Loading } from '../components/Loading';
import type { Connection, ConnectionKind, MeResponse } from '@wma/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, formatTime, type DriveFolder } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Returns a user-facing reason when the file cannot be uploaded, otherwise null. */
export function resumeProblem(file: File): string | null {
  const name = file.name.toLowerCase();
  const okType =
    name.endsWith('.pdf') ||
    name.endsWith('.docx') ||
    file.type === 'application/pdf' ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (!okType) return 'Only PDF or DOCX files can be used as a resume.';
  if (file.size > MAX_RESUME_BYTES) return 'That file is larger than 10 MB.';
  return null;
}

function statusLabel(c: Connection | undefined, scope: boolean): string {
  if (!c || c.status === 'disconnected') return scope ? 'Missing' : 'Not connected';
  return c.status === 'partial' ? 'Partial' : 'Connected';
}

function cfg(c: Connection | undefined, key: string): string | null {
  const v = c?.config?.[key];
  return typeof v === 'string' ? v : null;
}

function StatusBadge({ c, scope }: { c: Connection | undefined; scope: boolean }) {
  const label = statusLabel(c, scope);
  return <span className={`badge ${label.toLowerCase().replace(' ', '-')}`}>{label}</span>;
}

const GOOGLE: { kind: ConnectionKind; label: string; why: string }[] = [
  { kind: 'gmail', label: 'Gmail', why: 'Read and send scheduling and follow-up email' },
  { kind: 'calendar', label: 'Calendar', why: 'Read availability and book confirmed interviews' },
  { kind: 'drive', label: 'Drive', why: 'Read documents from folders you choose' },
];

export function ConnectionsPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<ReadonlySet<ConnectionKind>>(new Set());
  /** Sources with a save in flight; their editor cannot be closed or reopened until it settles. */
  const [pending, setPending] = useState<ReadonlySet<ConnectionKind>>(new Set());

  const reload = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError)
    return (
      <p role="alert" className="banner error">
        {loadError}
      </p>
    );
  if (!me) return <Loading />;

  const get = (k: ConnectionKind) => me.connections.find((c) => c.kind === k);
  const googleMissing = GOOGLE.some((g) => {
    const c = get(g.kind);
    return !c || c.status === 'disconnected';
  });

  const setEdit = (kind: ConnectionKind, on: boolean) =>
    setEditing((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  /** Runs a save; resolves true when it succeeded. */
  async function run(okText: string, fn: () => Promise<unknown>): Promise<boolean> {
    setNotice(null);
    try {
      await fn();
      setNotice({ kind: 'ok', text: okText });
      await reload();
      return true;
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
      return false;
    }
  }

  const setPendingFor = (kind: ConnectionKind, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  /** A save that hides the editor for `kind` once it has gone through; one at a time per source. */
  const save = async (kind: ConnectionKind, okText: string, fn: () => Promise<unknown>) => {
    if (pending.has(kind)) return;
    setPendingFor(kind, true);
    try {
      if (await run(okText, fn)) setEdit(kind, false);
    } finally {
      setPendingFor(kind, false);
    }
  };

  const changeButton = (kind: ConnectionKind, label: string) => (
    <button type="button" disabled={pending.has(kind)} onClick={() => setEdit(kind, true)}>
      {label}
    </button>
  );
  const cancelButton = (kind: ConnectionKind) => (
    <button type="button" disabled={pending.has(kind)} onClick={() => setEdit(kind, false)}>
      Cancel
    </button>
  );

  const disconnect = (kind: ConnectionKind, label: string) => (
    <ConfirmButton
      label="Disconnect"
      question={`Disconnect ${label}?`}
      confirmLabel="Yes, disconnect"
      busyLabel="Disconnecting…"
      onConfirm={async () => {
        await run(`${label} disconnected.`, () => api.disconnect(kind));
      }}
    />
  );

  const resume = get('resume');
  const linkedin = get('linkedin');
  const github = get('github');
  const drive = get('drive');
  const driveAvailable = !!drive && drive.status !== 'disconnected';
  const isOn = (c: Connection | undefined) => !!c && c.status !== 'disconnected';
  const driveFolders = (Array.isArray(drive?.config?.folders) ? drive.config.folders : []).filter(
    (f): f is { id: string; name: string } =>
      !!f && typeof f.id === 'string' && typeof f.name === 'string',
  );

  return (
    <section>
      <h1>Connections</h1>
      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`banner ${notice.kind}`}>
          {notice.text}
        </p>
      )}

      <h2>Google access</h2>
      <ul className="rows" aria-label="Google access">
        {GOOGLE.map((g) => {
          const c = get(g.kind);
          return (
            <li key={g.kind} data-testid={`google-${g.kind}`}>
              <strong>{g.label}</strong>
              <StatusBadge c={c} scope />
              <span className="muted grow">{g.why}</span>
            </li>
          );
        })}
      </ul>
      {googleMissing && (
        <p>
          Some access was not granted.{' '}
          <a className="button" href="/auth/google/start?reconnect=1">
            Reconnect with Google
          </a>
        </p>
      )}

      <h2>Profile sources</h2>

      <div className="card" aria-label="Resume">
        <div className="row">
          <h3>Resume</h3>
          <StatusBadge c={resume} scope={false} />
          {resume?.status === 'connected' && resume.connected_at && (
            <span className="muted">
              {cfg(resume, 'filename') ?? 'Uploaded'} · {formatTime(resume.connected_at)}
            </span>
          )}
          <span className="grow" />
          {resume && resume.status !== 'disconnected' && disconnect('resume', 'resume')}
        </div>
        {isOn(resume) && !editing.has('resume') ? (
          <p>{changeButton('resume', 'Replace')}</p>
        ) : (
          <>
            <ResumeUpload
              onUpload={(f) => save('resume', 'Resume uploaded.', () => api.uploadResume(f))}
            />
            {isOn(resume) && <p>{cancelButton('resume')}</p>}
          </>
        )}
      </div>

      <div className="card" aria-label="LinkedIn">
        <div className="row">
          <h3>LinkedIn</h3>
          <StatusBadge c={linkedin} scope={false} />
          {cfg(linkedin, 'url') && linkedin?.status !== 'disconnected' && (
            <span className="muted">{cfg(linkedin, 'url')}</span>
          )}
          <span className="grow" />
          {linkedin && linkedin.status !== 'disconnected' && disconnect('linkedin', 'LinkedIn')}
        </div>
        {isOn(linkedin) && !editing.has('linkedin') ? (
          <p>{changeButton('linkedin', 'Change')}</p>
        ) : (
          <>
            <SingleValueForm
              label="Public profile URL"
              placeholder="https://www.linkedin.com/in/your-name"
              button="Save LinkedIn"
              validate={(v) => {
                try {
                  const u = new URL(v);
                  return u.protocol === 'https:' || u.protocol === 'http:'
                    ? null
                    : 'Enter a full profile URL.';
                } catch {
                  return 'Enter a full profile URL, starting with https://';
                }
              }}
              onSubmit={(v) => save('linkedin', 'LinkedIn saved.', () => api.setLinkedIn(v))}
            />
            {isOn(linkedin) && <p>{cancelButton('linkedin')}</p>}
          </>
        )}
      </div>

      <div className="card" aria-label="GitHub">
        <div className="row">
          <h3>GitHub</h3>
          <StatusBadge c={github} scope={false} />
          {cfg(github, 'username') && github?.status !== 'disconnected' && (
            <span className="muted">{cfg(github, 'username')}</span>
          )}
          <span className="grow" />
          {github && github.status !== 'disconnected' && disconnect('github', 'GitHub')}
        </div>
        {isOn(github) && !editing.has('github') ? (
          <p>{changeButton('github', 'Change')}</p>
        ) : (
          <>
            <SingleValueForm
              label="GitHub username"
              placeholder="your-username"
              button="Save GitHub"
              validate={(v) =>
                /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(v)
                  ? null
                  : 'Enter a valid GitHub username.'
              }
              onSubmit={(v) => save('github', 'GitHub saved.', () => api.setGitHub(v))}
            />
            {isOn(github) && <p>{cancelButton('github')}</p>}
          </>
        )}
      </div>

      <div className="card" aria-label="Drive folders">
        <div className="row">
          <h3>Drive folders</h3>
          <StatusBadge c={drive} scope />
          <span className="grow" />
          {drive && drive.status !== 'disconnected' && disconnect('drive', 'Drive folders')}
        </div>
        {driveAvailable && driveFolders.length > 0 && !editing.has('drive') ? (
          <>
            <ul className="chips" aria-label="Saved Drive folders">
              {driveFolders.map((f) => (
                <li key={f.id}>{f.name}</li>
              ))}
            </ul>
            <p>{changeButton('drive', 'Change folders')}</p>
          </>
        ) : driveAvailable ? (
          <>
            <DrivePicker
              initial={
                Array.isArray(drive?.config?.folder_ids)
                  ? (drive.config.folder_ids as string[])
                  : []
              }
              autoLoad={editing.has('drive')}
              onSave={(ids) =>
                save('drive', 'Drive folders saved.', () => api.setDriveFolders(ids))
              }
            />
            {driveFolders.length > 0 && <p>{cancelButton('drive')}</p>}
          </>
        ) : (
          <p className="muted">
            Drive access is missing. Reconnect with Google and allow Drive to choose folders.
          </p>
        )}
      </div>
    </section>
  );
}

function ResumeUpload({ onUpload }: { onUpload: (f: File) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handle(file: File | undefined) {
    if (!file || busy) return;
    const problem = resumeProblem(file);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await onUpload(file);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        className={`drop${over ? ' over' : ''}`}
        aria-busy={busy}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handle(e.dataTransfer.files[0]);
        }}
      >
        <span>{busy ? 'Uploading…' : 'Drop a PDF or DOCX here, or'}</span>
        <label className="button" aria-disabled={busy}>
          Choose file
          <input
            ref={input}
            type="file"
            disabled={busy}
            aria-label="Resume file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden
            onChange={(e) => {
              void handle(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        <span className="muted">Up to 10 MB</span>
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

interface SingleProps {
  label: string;
  placeholder: string;
  button: string;
  validate: (v: string) => string | null;
  onSubmit: (v: string) => Promise<void>;
}

function SingleValueForm({ label, placeholder, button, validate, onSubmit }: SingleProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const v = value.trim();
        const problem = v ? validate(v) : 'This field is required.';
        setError(problem);
        if (problem) return;
        setBusy(true);
        try {
          await onSubmit(v);
          setValue('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {label}
        <input
          value={value}
          disabled={busy}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : button}
      </button>
      {error && (
        <span role="alert" className="field-error">
          {error}
        </span>
      )}
    </form>
  );
}

function DrivePicker({
  initial,
  autoLoad,
  onSave,
}: {
  initial: string[];
  autoLoad?: boolean;
  onSave: (ids: string[]) => Promise<void>;
}) {
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setFolders((await api.driveFolders()).folders);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (autoLoad) void load();
  }, [autoLoad]);

  if (!folders) {
    return (
      <div>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? 'Loading folders…' : 'Choose folders'}
        </button>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave([...selected]);
        } finally {
          setSaving(false);
        }
      }}
    >
      {folders.length === 0 ? (
        <p className="muted">No folders found in your Drive.</p>
      ) : (
        <ul className="checks" aria-label="Drive folders list">
          {folders.map((f) => (
            <li key={f.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(f.id);
                    else next.delete(f.id);
                    setSelected(next);
                  }}
                />
                {f.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      <button type="submit" className="primary" disabled={selected.size === 0 || saving}>
        {saving ? 'Saving…' : 'Save folders'}
      </button>
    </form>
  );
}
