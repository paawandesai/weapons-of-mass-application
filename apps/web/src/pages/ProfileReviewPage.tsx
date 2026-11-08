import {
  profileDocumentSchema,
  type BuildStatus,
  unresolvedBlockingFlags,
  type ProfileDocument,
  type ProfileFlag,
} from '@wma/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, errorMessage, formatTime } from '../api';
import { Loading } from '../components/Loading';
import { getAt, sameValue, setAt } from '../profilePaths';

type Kind = 'text' | 'area' | 'month' | 'lines' | 'tri' | 'date' | 'list';
interface Spec {
  key: string;
  label: string;
  kind?: Kind;
  /** Non-nullable in the schema: keep an empty string instead of null. */
  required?: boolean;
}

const IDENTITY: Spec[] = [
  { key: 'full_name', label: 'Full name', required: true },
  { key: 'headline', label: 'Headline' },
  { key: 'location', label: 'Location' },
  { key: 'summary', label: 'Summary', kind: 'area' },
];
const CONTACT: Spec[] = [
  { key: 'email', label: 'Email', required: true },
  { key: 'phone', label: 'Phone' },
  { key: 'linkedin_url', label: 'LinkedIn URL' },
  { key: 'github_url', label: 'GitHub URL' },
  { key: 'website_url', label: 'Website URL' },
];
const WORK: Spec[] = [
  { key: 'employer', label: 'Employer', required: true },
  { key: 'title', label: 'Title', required: true },
  { key: 'location', label: 'Location' },
  { key: 'start_date', label: 'Start (YYYY-MM or YYYY)', kind: 'month' },
  { key: 'end_date', label: 'End (YYYY-MM or YYYY)', kind: 'month' },
  { key: 'summary', label: 'Summary', kind: 'area' },
  { key: 'highlights', label: 'Highlights (one per line)', kind: 'lines' },
];
const PROJECT: Spec[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'description', label: 'Description', kind: 'area' },
  { key: 'url', label: 'URL' },
  { key: 'technologies', label: 'Technologies (one per line)', kind: 'lines' },
  { key: 'start_date', label: 'Start (YYYY-MM or YYYY)', kind: 'month' },
  { key: 'end_date', label: 'End (YYYY-MM or YYYY)', kind: 'month' },
];
const EDUCATION: Spec[] = [
  { key: 'institution', label: 'Institution', required: true },
  { key: 'degree', label: 'Degree' },
  { key: 'field', label: 'Field of study' },
  { key: 'start_date', label: 'Start (YYYY-MM or YYYY)', kind: 'month' },
  { key: 'end_date', label: 'End (YYYY-MM or YYYY)', kind: 'month' },
];
const STANDARD: Spec[] = [
  { key: 'work_authorization', label: 'Work authorization' },
  { key: 'visa_sponsorship_required', label: 'Visa sponsorship required', kind: 'tri' },
  { key: 'start_date', label: 'Start date (as text)' },
  { key: 'earliest_start_date', label: 'Earliest start date', kind: 'date' },
  { key: 'notice_period', label: 'Notice period' },
  { key: 'reasons_for_change', label: 'Reasons for change', kind: 'area' },
  {
    key: 'previous_interviews',
    label: 'Companies interviewed at before (comma-separated)',
    kind: 'list',
  },
];

const REMOTE = ['remote', 'hybrid', 'onsite', 'any'] as const;

function cleanLines(list: string[]): string[] {
  return list.map((s) => s.trim()).filter(Boolean);
}

/** Drop blank lines that only exist while the user is typing. */
function cleanDocument(doc: ProfileDocument): ProfileDocument {
  const d = structuredClone(doc);
  d.preferences.target_titles = cleanLines(d.preferences.target_titles);
  d.preferences.locations = cleanLines(d.preferences.locations);
  for (const w of d.work_history) w.highlights = cleanLines(w.highlights);
  for (const p of d.projects) p.technologies = cleanLines(p.technologies);
  if (d.standard_answers.previous_interviews) {
    d.standard_answers.previous_interviews = cleanLines(d.standard_answers.previous_interviews);
  }
  return d;
}

const STEP_LABELS = {
  gathering: 'Reading your sources',
  extracting: 'Extracting your profile',
  checking: 'Checking it against your sources',
} as const;
const STEP_VALUES = { gathering: 0, extracting: 1, checking: 2 } as const;

/** Determinate progress for a running build; a missing step reads as the first phase. */
function BuildProgress({ status }: { status: BuildStatus | null }) {
  const step = status?.step ?? 'gathering';
  return (
    <div className="build-progress">
      <progress max={3} value={STEP_VALUES[step]} aria-label="Profile build progress" />
      <span className="muted"> {STEP_LABELS[step]}</span>
    </div>
  );
}

/** Moves to the field a flag points at: the exact id, else the first field inside that entry. */
function goToField(path: string) {
  const target =
    document.getElementById(`f-${path}`) ??
    document.querySelector(`[id^="f-${CSS.escape(path)}."]`);
  if (!target) return;
  target.scrollIntoView?.({ block: 'center' });
  const control = target.matches('input, select, textarea')
    ? target
    : target.querySelector<HTMLElement>('input, select, textarea');
  (control as HTMLElement | null)?.focus();
}

interface FieldProps {
  doc: ProfileDocument;
  base: string;
  spec: Spec;
  onChange: (path: string, value: unknown) => void;
}

/** Comma-separated list; the text is kept locally so a trailing comma survives typing. */
function ListInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string[] | null;
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState((value ?? []).join(', '));
  return (
    <input
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value === '' ? [] : e.target.value.split(','));
      }}
    />
  );
}

function Field({ doc, base, spec, onChange }: FieldProps) {
  const path = `${base}.${spec.key}`;
  const id = `f-${path}`;
  const value = getAt(doc, path);
  const kind = spec.kind ?? 'text';

  let control;
  if (kind === 'area') {
    control = (
      <textarea
        id={id}
        rows={3}
        value={(value as string | null) ?? ''}
        onChange={(e) => onChange(path, e.target.value === '' ? null : e.target.value)}
      />
    );
  } else if (kind === 'lines') {
    control = (
      <textarea
        id={id}
        rows={3}
        value={((value as string[] | undefined) ?? []).join('\n')}
        onChange={(e) => onChange(path, e.target.value === '' ? [] : e.target.value.split('\n'))}
      />
    );
  } else if (kind === 'list') {
    control = (
      <ListInput id={id} value={value as string[] | null} onChange={(v) => onChange(path, v)} />
    );
  } else if (kind === 'date') {
    control = (
      <input
        id={id}
        type="date"
        value={(value as string | null) ?? ''}
        onChange={(e) => onChange(path, e.target.value === '' ? null : e.target.value)}
      />
    );
  } else if (kind === 'tri') {
    const v = value === true ? 'yes' : value === false ? 'no' : '';
    control = (
      <select
        id={id}
        value={v}
        onChange={(e) => onChange(path, e.target.value === '' ? null : e.target.value === 'yes')}
      >
        <option value="">Not specified</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  } else {
    control = (
      <input
        id={id}
        value={(value as string | null) ?? ''}
        placeholder={kind === 'month' ? 'YYYY-MM or YYYY' : undefined}
        onChange={(e) =>
          onChange(path, e.target.value === '' && !spec.required ? null : e.target.value)
        }
      />
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{spec.label}</label>
      {control}
    </div>
  );
}

function EntryList(props: {
  doc: ProfileDocument;
  listKey: 'work_history' | 'projects' | 'education';
  specs: Spec[];
  titleKey: string;
  onChange: (path: string, value: unknown) => void;
  onRemove: (index: number) => void;
}) {
  const items = props.doc[props.listKey] as unknown as Record<string, unknown>[];
  if (items.length === 0) return <p className="muted">Nothing here yet.</p>;
  return (
    <>
      {items.map((item, i) => (
        <fieldset className="card" key={i} id={`f-${props.listKey}.${i}`}>
          <legend>{(item[props.titleKey] as string) || `Entry ${i + 1}`}</legend>
          {props.specs.map((s) => (
            <Field
              key={s.key}
              doc={props.doc}
              base={`${props.listKey}.${i}`}
              spec={s}
              onChange={props.onChange}
            />
          ))}
          <p className="muted small">Taken from: {(item.sources as string[]).join(', ')}</p>
          <button type="button" className="danger" onClick={() => props.onRemove(i)}>
            Remove entry
          </button>
        </fieldset>
      ))}
    </>
  );
}

export function ProfileReviewPage({ pollMs = 2000 }: { pollMs?: number }) {
  const [saved, setSaved] = useState<ProfileDocument | null>(null);
  const [draft, setDraft] = useState<ProfileDocument | null>(null);
  /** The document as the flags were raised on it; saving does not move it, so edits stay detectable. */
  const [baseline, setBaseline] = useState<ProfileDocument | null>(null);
  const [version, setVersion] = useState(0);
  const [approvedVersion, setApprovedVersion] = useState<number | null>(null);
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [message, setMessage] = useState<{
    kind: 'ok' | 'error';
    text: string;
    runsLink?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'approve'>(null);
  const [building, setBuilding] = useState(false);
  /** A build that was already running when the page opened (the first one, started by the survey). */
  const [initialBuild, setInitialBuild] = useState(false);
  /** The latest status seen while a build runs, for the progress bar. */
  const [buildStatus, setBuildStatus] = useState<BuildStatus | null>(null);
  const [builtFrom, setBuiltFrom] = useState<string[]>([]);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const p = await api.profile();
      if (!alive.current) return;
      setSaved(p.document);
      setDraft(p.document);
      setBaseline(p.document);
      setVersion(p.version);
      setBuiltFrom(p.built_from ?? []);
      setApprovedVersion(p.approved_version);
      setApprovedAt(p.approved_at);
      setState('ready');
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.code === 'no_profile') setState('empty');
      else {
        setState('error');
        setMessage({ kind: 'error', text: errorMessage(e) });
      }
    }
  }, []);

  /** Polls the build status until it ends, then loads the result. Returns false if unmounted. */
  const awaitBuild = useCallback(
    async (doneText: string): Promise<boolean> => {
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (!alive.current) return false;
        const s = await api.buildStatus();
        if (alive.current) setBuildStatus(s);
        if (s.state === 'done') {
          await load();
          if (!alive.current) return false;
          setMessage({
            kind: 'ok',
            text: doneText,
          });
          return true;
        }
        if (s.state === 'failed') {
          setMessage({
            kind: 'error',
            text: `The rebuild did not finish${s.reason ? `: ${s.reason}` : '.'}`,
          });
          return true;
        }
      }
    },
    [load, pollMs],
  );

  useEffect(() => {
    alive.current = true;
    void (async () => {
      let running = false;
      try {
        const first = await api.buildStatus();
        running = first.state === 'running';
        if (running && alive.current) setBuildStatus(first);
      } catch {
        // Status is only a hint here; the profile load below reports real failures.
      }
      if (!alive.current) return;
      if (!running) {
        await load();
        return;
      }
      setInitialBuild(true);
      try {
        await awaitBuild('Your profile was built from your sources. Review it below.');
      } catch (e) {
        if (alive.current) setMessage({ kind: 'error', text: errorMessage(e) });
      }
      if (!alive.current) return;
      setInitialBuild(false);
      await load();
    })();
    return () => {
      alive.current = false;
    };
  }, [load, awaitBuild]);

  const rebuild = useCallback(async () => {
    setMessage(null);
    setBuildStatus(null);
    setBuilding(true);
    try {
      await api.startBuild();
      await awaitBuild('Your profile was rebuilt. Review the new version below.');
    } catch (e) {
      if (!alive.current) return;
      setMessage({
        kind: 'error',
        text:
          e instanceof ApiError && e.code === 'no_resume'
            ? 'Upload a resume on the Connections page before building a profile.'
            : errorMessage(e),
      });
    } finally {
      if (alive.current) setBuilding(false);
    }
  }, [awaitBuild]);

  const neverBuilt = state !== 'ready' || builtFrom.length === 0;
  const RebuildButton = (
    <button type="button" onClick={rebuild} disabled={building}>
      {building
        ? neverBuilt
          ? 'Building…'
          : 'Rebuilding…'
        : neverBuilt
          ? 'Build from sources'
          : 'Rebuild from sources'}
    </button>
  );

  if (initialBuild)
    return (
      <section>
        <h1>Profile review</h1>
        <div role="status" className="banner">
          <p>Building your profile from your connected sources…</p>
          <BuildProgress status={buildStatus} />
        </div>
      </section>
    );
  if (state === 'loading') return <Loading />;
  if (state === 'error')
    return (
      <p role="alert" className="banner error">
        {message?.text}
      </p>
    );
  if (state === 'empty' || !draft || !saved || !baseline) {
    return (
      <section>
        <h1>Profile review</h1>
        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`banner ${message.kind}`}
          >
            {message.text}
          </p>
        )}
        <p>
          No profile has been built yet. Add a resume on the Connections page, then build your
          profile.
        </p>
        <p>
          <Link to="/connections">Go to connections</Link> {RebuildButton}
        </p>
      </section>
    );
  }

  const dirty = !sameValue(saved, draft);
  // A blocking flag stands until the user removes it; partial_source flags never block.
  const open = unresolvedBlockingFlags(draft.flags);
  const blocked = open.length > 0;

  const change = (path: string, value: unknown) => setDraft((d) => (d ? setAt(d, path, value) : d));
  const remove = (key: 'work_history' | 'projects' | 'education' | 'skills', i: number) =>
    setDraft((d) => (d ? { ...d, [key]: d[key].filter((_, j) => j !== i) } : d));

  /** Entries a flag points at: both entries of a date conflict, otherwise its single path. */
  const flagPaths = (f: ProfileFlag): string[] =>
    f.paths && f.paths.length > 0 ? f.paths : f.path ? [f.path] : [];
  /** A flag can be resolved once any entry it points at was edited or removed. */
  const canResolve = (f: ProfileFlag) => {
    const paths = flagPaths(f);
    return (
      paths.length === 0 ||
      paths.some(
        (p) => getAt(baseline, p) === undefined || !sameValue(getAt(baseline, p), getAt(draft, p)),
      )
    );
  };
  const entryTitle = (doc: ProfileDocument, path: string): string | null => {
    const e = getAt(doc, path) as Record<string, unknown> | undefined;
    const t = e?.employer ?? e?.name ?? e?.institution;
    return typeof t === 'string' && t !== '' ? t : null;
  };
  const resolve = (id: string) =>
    setDraft((d) => (d ? { ...d, flags: d.flags.filter((f) => f.id !== id) } : d));

  /** Saves the draft as a new version and returns its number, or null when it cannot be saved. */
  async function persist(): Promise<number | null> {
    if (!draft) return null;
    const doc = cleanDocument(draft);
    const parsed = profileDocumentSchema.safeParse(doc);
    if (!parsed.success) {
      const first = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      setMessage({ kind: 'error', text: `Some fields need attention before saving. ${first}` });
      return null;
    }
    const res = await api.saveProfile(parsed.data);
    setSaved(parsed.data);
    setDraft(parsed.data);
    setVersion(res.version);
    return res.version;
  }

  async function save() {
    setMessage(null);
    setBusy('save');
    try {
      if ((await persist()) !== null) setMessage({ kind: 'ok', text: 'Saved as a new version.' });
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (building) return;
    setMessage(null);
    setBusy('approve');
    try {
      // Approve exactly the version on screen (the one just saved, if there were edits).
      let reviewed = version;
      if (dirty) {
        const newVersion = await persist();
        if (newVersion === null) return;
        reviewed = newVersion;
      }
      const r = await api.approve(reviewed);
      setApprovedVersion(r.approved_version);
      setApprovedAt(r.approved_at);
      setMessage(
        r.run_started
          ? { kind: 'ok', text: 'Profile approved. Your first run has started.', runsLink: true }
          : { kind: 'ok', text: 'Profile approved.' },
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unresolved_flags') {
        setMessage({ kind: 'error', text: 'Resolve the flagged items before approving.' });
        await load();
      } else if (e instanceof ApiError && e.code === 'version_mismatch') {
        await load();
        setMessage({
          kind: 'error',
          text: 'A newer version of your profile arrived while you were reviewing. It is loaded below; review it and approve again.',
        });
      } else setMessage({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const isApproved = approvedVersion !== null && approvedVersion === version && approvedAt;

  return (
    <section>
      <div className="row">
        <h1 className="grow">Profile review</h1>
        <span className="muted">Version {version}</span>
        {RebuildButton}
      </div>

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`banner ${message.kind}`}
        >
          {message.text}
          {message.runsLink && (
            <>
              {' '}
              <Link to="/runs">See your runs</Link>
            </>
          )}
        </p>
      )}

      {building && <BuildProgress status={buildStatus} />}

      {isApproved ? (
        <p className="banner ok" aria-label="Approval status">
          Approved <time dateTime={approvedAt!}>{formatTime(approvedAt!)}</time>
        </p>
      ) : approvedVersion !== null && approvedAt ? (
        <p className="banner" aria-label="Approval status">
          Version {version} is waiting for your review. The agent is still using version{' '}
          {approvedVersion}, approved <time dateTime={approvedAt}>{formatTime(approvedAt)}</time>.
        </p>
      ) : null}

      <aside className="card flags" aria-label="Flagged items">
        <h2>Flagged items</h2>
        {draft.flags.length === 0 ? (
          <p className="muted">Nothing needs your attention.</p>
        ) : (
          <ul className="rows">
            {draft.flags.map((f) => (
              <li key={f.id} data-testid={`flag-${f.id}`}>
                <span className="badge partial">{f.kind.replace(/_/g, ' ')}</span>
                <span className="grow">
                  {f.message}
                  {f.sources.length > 0 && <span className="muted"> · {f.sources.join(', ')}</span>}
                </span>
                {flagPaths(f).map((p, n, all) => (
                  <a
                    key={p}
                    href={`#f-${p}`}
                    onClick={(e) => {
                      e.preventDefault();
                      goToField(p);
                    }}
                  >
                    {all.length > 1 ? (entryTitle(draft, p) ?? 'Go to field') : 'Go to field'}
                  </a>
                ))}
                <button
                  type="button"
                  disabled={!canResolve(f)}
                  title={canResolve(f) ? undefined : 'Edit the field first'}
                  aria-label={`Resolve: ${f.message}`}
                  onClick={() => resolve(f.id)}
                >
                  Resolve
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <h2>Identity</h2>
      <div className="card">
        {IDENTITY.map((s) => (
          <Field key={s.key} doc={draft} base="identity" spec={s} onChange={change} />
        ))}
      </div>

      <h2>Contact</h2>
      <div className="card">
        {CONTACT.map((s) => (
          <Field key={s.key} doc={draft} base="contact" spec={s} onChange={change} />
        ))}
      </div>

      <h2>Work history</h2>
      <EntryList
        doc={draft}
        listKey="work_history"
        specs={WORK}
        titleKey="employer"
        onChange={change}
        onRemove={(i) => remove('work_history', i)}
      />

      <h2>Projects</h2>
      <EntryList
        doc={draft}
        listKey="projects"
        specs={PROJECT}
        titleKey="name"
        onChange={change}
        onRemove={(i) => remove('projects', i)}
      />

      <h2>Education</h2>
      <EntryList
        doc={draft}
        listKey="education"
        specs={EDUCATION}
        titleKey="institution"
        onChange={change}
        onRemove={(i) => remove('education', i)}
      />

      <h2>Skills</h2>
      <div className="card">
        {draft.skills.map((s, i) => (
          <div className="row" key={i}>
            <input
              aria-label={`Skill ${i + 1} name`}
              id={`f-skills.${i}.name`}
              value={s.name}
              onChange={(e) => change(`skills.${i}.name`, e.target.value)}
            />
            <input
              aria-label={`Skill ${i + 1} category`}
              id={`f-skills.${i}.category`}
              placeholder="Category"
              value={s.category ?? ''}
              onChange={(e) =>
                change(`skills.${i}.category`, e.target.value === '' ? null : e.target.value)
              }
            />
            <button type="button" className="danger" onClick={() => remove('skills', i)}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setDraft({ ...draft, skills: [...draft.skills, { name: '', category: null }] })
          }
        >
          Add skill
        </button>
      </div>

      <h2>Preferences</h2>
      <div className="card">
        <Field
          doc={draft}
          base="preferences"
          spec={{ key: 'target_titles', label: 'Target titles (one per line)', kind: 'lines' }}
          onChange={change}
        />
        <Field
          doc={draft}
          base="preferences"
          spec={{ key: 'locations', label: 'Locations (one per line)', kind: 'lines' }}
          onChange={change}
        />
        <div className="field">
          <label htmlFor="f-preferences.remote">Remote preference</label>
          <select
            id="f-preferences.remote"
            value={draft.preferences.remote}
            onChange={(e) => change('preferences.remote', e.target.value)}
          >
            {REMOTE.map((r) => (
              <option key={r} value={r}>
                {r[0]!.toUpperCase() + r.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <h2>Standard answers</h2>
      <div className="card">
        {STANDARD.map((s) => (
          <Field key={s.key} doc={draft} base="standard_answers" spec={s} onChange={change} />
        ))}
      </div>

      <h2>Survey answers</h2>
      <div className="card">
        <p>
          Target roles: {draft.survey.target_roles.join(', ') || 'none'} · Salary floor:{' '}
          {draft.survey.salary_floor ?? 'not set'} · Applications per day:{' '}
          {draft.survey.daily_target}
        </p>
        <Link to="/survey">Edit survey answers</Link>
      </div>

      <div className="actions">
        <button type="button" onClick={save} disabled={!dirty || busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save as new version'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={approve}
          disabled={blocked || busy !== null || building}
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        {building && (
          <span className="muted">Approval is available when the rebuild finishes.</span>
        )}
        {blocked && (
          <span className="muted">
            Resolve {open.length} flagged {open.length === 1 ? 'item' : 'items'} to approve.
          </span>
        )}
      </div>
    </section>
  );
}
