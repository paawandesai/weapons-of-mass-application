import { Loading } from '../components/Loading';
import type { SurveyAnswers } from '@wma/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api';

export const DEFAULT_DAILY_TARGET = 12;

interface FormState {
  target_roles: string;
  salary_floor: string;
  work_life_balance: string;
  family_constraints: string;
  relocate: '' | 'yes' | 'no';
  career_direction: string;
  daily_target: string;
}

type Errors = Partial<Record<keyof FormState, string>>;

const EMPTY: FormState = {
  target_roles: '',
  salary_floor: '',
  work_life_balance: '',
  family_constraints: '',
  relocate: '',
  career_direction: '',
  daily_target: String(DEFAULT_DAILY_TARGET),
};

function fromAnswers(a: SurveyAnswers): FormState {
  return {
    target_roles: a.target_roles.join(', '),
    salary_floor: a.salary_floor === null ? '' : String(a.salary_floor),
    work_life_balance: a.work_life_balance ?? '',
    family_constraints: a.family_constraints ?? '',
    relocate: a.willing_to_relocate === null ? '' : a.willing_to_relocate ? 'yes' : 'no',
    career_direction: a.career_direction ?? '',
    daily_target: String(a.daily_target),
  };
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

export function validateSurvey(
  f: FormState,
): { answers: SurveyAnswers; errors?: undefined } | { errors: Errors; answers?: undefined } {
  const errors: Errors = {};
  const roles = f.target_roles
    .split(/[,\n]/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (roles.length === 0) errors.target_roles = 'Enter at least one target role.';

  let salary: number | null = null;
  if (f.salary_floor.trim() === '') errors.salary_floor = 'Enter your minimum salary.';
  else {
    salary = Number(f.salary_floor);
    if (!Number.isInteger(salary) || salary < 0)
      errors.salary_floor = 'Salary must be a whole number of zero or more.';
  }

  let target = DEFAULT_DAILY_TARGET;
  if (f.daily_target.trim() !== '') {
    target = Number(f.daily_target);
    if (!Number.isInteger(target) || target < 1 || target > 30)
      errors.daily_target = 'Daily target must be a whole number from 1 to 30.';
  }

  if (Object.keys(errors).length) return { errors };
  return {
    answers: {
      target_roles: roles,
      salary_floor: salary,
      work_life_balance: orNull(f.work_life_balance),
      family_constraints: orNull(f.family_constraints),
      willing_to_relocate: f.relocate === '' ? null : f.relocate === 'yes',
      career_direction: orNull(f.career_direction),
      daily_target: target,
    },
  };
}

export function SurveyPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [loaded, setLoaded] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .survey()
      .then((r) => live && r.answers && setForm(fromAnswers(r.answers)))
      .catch((e) => live && setSubmitError(errorMessage(e)))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const result = validateSurvey(form);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api.saveSurvey(result.answers);
      navigate('/profile/review');
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <Loading />;

  const invalid = (k: keyof FormState) => (errors[k] ? true : undefined);
  const err = (k: keyof FormState) =>
    errors[k] ? (
      <span role="alert" className="field-error" id={`${k}-error`}>
        {errors[k]}
      </span>
    ) : null;

  return (
    <section>
      <h1>Survey</h1>
      <p className="muted">
        A few things no connected source can tell the agent. You can change these any time.
      </p>
      {submitError && (
        <p role="alert" className="banner error">
          {submitError}
        </p>
      )}
      <form className="stack" onSubmit={submit} noValidate>
        <label>
          Target roles
          <input
            value={form.target_roles}
            aria-invalid={invalid('target_roles')}
            aria-describedby={errors.target_roles ? 'target_roles-error' : undefined}
            placeholder="Staff engineer, Engineering manager"
            onChange={(e) => set('target_roles', e.target.value)}
          />
          <small className="muted">Separate roles with commas.</small>
          {err('target_roles')}
        </label>
        <label>
          Salary floor (annual, in your local currency)
          <input
            inputMode="numeric"
            value={form.salary_floor}
            aria-invalid={invalid('salary_floor')}
            aria-describedby={errors.salary_floor ? 'salary_floor-error' : undefined}
            onChange={(e) => set('salary_floor', e.target.value)}
          />
          {err('salary_floor')}
        </label>
        <label>
          Work-life balance priorities
          <textarea
            rows={3}
            value={form.work_life_balance}
            onChange={(e) => set('work_life_balance', e.target.value)}
          />
        </label>
        <label>
          Family or location constraints
          <textarea
            rows={3}
            value={form.family_constraints}
            onChange={(e) => set('family_constraints', e.target.value)}
          />
        </label>
        <label>
          Willing to relocate
          <select
            value={form.relocate}
            onChange={(e) => set('relocate', e.target.value as FormState['relocate'])}
          >
            <option value="">Prefer not to say</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label>
          Career direction
          <textarea
            rows={3}
            value={form.career_direction}
            onChange={(e) => set('career_direction', e.target.value)}
          />
        </label>
        <label>
          Applications per day
          <input
            type="number"
            min={1}
            max={30}
            value={form.daily_target}
            aria-invalid={invalid('daily_target')}
            aria-describedby={errors.daily_target ? 'daily_target-error' : undefined}
            onChange={(e) => set('daily_target', e.target.value)}
          />
          <small className="muted">Between 1 and 30. Leave blank for {DEFAULT_DAILY_TARGET}.</small>
          {err('daily_target')}
        </label>
        <div>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save and continue'}
          </button>
        </div>
      </form>
    </section>
  );
}
