import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FieldDescriptor, FieldValues, FormAdapter } from '../../src/submission/types';
import {
  ashbyAdapter,
  classifyField,
  findUnmappedRequired,
  greenhouseAdapter,
  leverAdapter,
  reportUnmappedFields,
  screenshotOnFailure,
  selectAdapter,
} from '../../src/submission/adapters';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/forms');
const fixtureUrl = (vendor: string, file: string, query = '') =>
  pathToFileURL(join(FIXTURES, vendor, file)).toString() + query;

const PDF = { filename: 'resume.pdf', bytes: Buffer.from('%PDF-1.4\n%fixture\n') };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

function fakeCtx() {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    ctx: {
      handle: { tenantId: 'tenant-1' },
      application: { id: 'app-1', attemptCount: 0 },
      files: {
        put: async (key: string, bytes: Uint8Array) => void stored.set(key, bytes),
        get: async () => null,
        delete: async () => undefined,
      },
    } as unknown as Parameters<typeof screenshotOnFailure>[1],
  };
}

interface Vendor {
  name: string;
  dir: string;
  adapter: FormAdapter;
  /** id -> [required, classification, type] for every question on the form. */
  expected: Record<string, [boolean, FieldDescriptor['classification'], FieldDescriptor['type']]>;
  values: FieldValues;
  /** Self-identification ids that must stay untouched. */
  selfId: string[];
}

const VENDORS: Vendor[] = [
  {
    name: 'greenhouse',
    dir: 'greenhouse',
    adapter: greenhouseAdapter,
    expected: {
      first_name: [true, 'standard', 'text'],
      last_name: [true, 'standard', 'text'],
      email: [true, 'standard', 'text'],
      phone: [false, 'standard', 'text'],
      resume: [true, 'resume', 'file'],
      cover_letter: [false, 'free-text', 'file'],
      job_application_answers_attributes_0_text_value: [false, 'standard', 'text'],
      job_application_answers_attributes_1_text_value: [true, 'free-text', 'textarea'],
      auth: [true, 'standard', 'select'],
      sponsorship: [true, 'standard', 'radio'],
      privacy: [true, 'standard', 'checkbox'],
      job_application_gender: [false, 'self-identification', 'select'],
      job_application_hispanic_ethnicity: [false, 'self-identification', 'select'],
      job_application_race: [false, 'self-identification', 'select'],
      job_application_veteran_status: [false, 'self-identification', 'select'],
      job_application_disability_status: [false, 'self-identification', 'select'],
    },
    values: {
      first_name: 'Mara',
      last_name: 'Quill',
      email: 'mara@example.com',
      phone: '555-0100',
      job_application_answers_attributes_0_text_value: 'https://linkedin.com/in/mara',
      job_application_answers_attributes_1_text_value: 'I enjoy platform work.',
      auth: 'Yes',
      sponsorship: 'No',
      privacy: true,
      job_application_gender: 'Female',
      job_application_race: 'Asian',
    },
    selfId: [
      'job_application_gender',
      'job_application_hispanic_ethnicity',
      'job_application_race',
      'job_application_veteran_status',
      'job_application_disability_status',
    ],
  },
  {
    name: 'lever',
    dir: 'lever',
    adapter: leverAdapter,
    expected: {
      'resume-upload-input': [true, 'resume', 'file'],
      name: [true, 'standard', 'text'],
      email: [true, 'standard', 'text'],
      phone: [false, 'standard', 'text'],
      org: [false, 'standard', 'text'],
      'urls[LinkedIn]': [false, 'standard', 'text'],
      'urls[GitHub]': [false, 'standard', 'text'],
      'cards[a1b2c3][field0]': [true, 'free-text', 'textarea'],
      'cards[a1b2c3][field1]': [true, 'standard', 'select'],
      'cards[a1b2c3][field2]': [true, 'standard', 'radio'],
      comments: [false, 'free-text', 'textarea'],
      'eeo[gender]': [false, 'self-identification', 'select'],
      'eeo[race]': [false, 'self-identification', 'select'],
      'eeo[veteran]': [false, 'self-identification', 'select'],
      'eeo[disability]': [false, 'self-identification', 'select'],
    },
    values: {
      name: 'Mara Quill',
      email: 'mara@example.com',
      phone: '555-0100',
      org: 'Initech',
      'urls[LinkedIn]': 'https://linkedin.com/in/mara',
      'cards[a1b2c3][field0]': 'I scaled a queue to 10k jobs per second.',
      'cards[a1b2c3][field1]': 'Yes',
      'cards[a1b2c3][field2]': 'No',
      'eeo[gender]': 'Female',
    },
    selfId: ['eeo[gender]', 'eeo[race]', 'eeo[veteran]', 'eeo[disability]'],
  },
  {
    name: 'ashby',
    dir: 'ashby',
    adapter: ashbyAdapter,
    expected: {
      _systemfield_name: [true, 'standard', 'text'],
      _systemfield_email: [true, 'standard', 'text'],
      _systemfield_resume: [true, 'resume', 'file'],
      'phone-1': [false, 'standard', 'text'],
      'q-linkedin': [false, 'standard', 'text'],
      'q-why': [true, 'free-text', 'textarea'],
      'q-sponsor': [true, 'standard', 'select'],
      'q-stack': [true, 'free-text', 'checkbox'],
      'eeo-gender': [false, 'self-identification', 'select'],
      'eeo-race': [false, 'self-identification', 'select'],
      'eeo-veteran': [false, 'self-identification', 'select'],
      'eeo-disability': [false, 'self-identification', 'select'],
    },
    values: {
      _systemfield_name: 'Mara Quill',
      _systemfield_email: 'mara@example.com',
      'phone-1': '555-0100',
      'q-why': 'I like building platforms.',
      'q-sponsor': 'No',
      'q-stack': ['Kubernetes', 'Postgres'],
      'eeo-gender': 'Woman',
    },
    selfId: ['eeo-gender', 'eeo-race', 'eeo-veteran', 'eeo-disability'],
  },
];

const ids = (fields: FieldDescriptor[]) => fields.map((f) => f.id).sort();

describe('selectAdapter', () => {
  it.each([
    ['https://jobs.ashbyhq.com/acme/8c3f0a52-0e2b-4b55-9a4e-0d3f6b0f6a11/application', 'ashby'],
    ['https://jobs.ashbyhq.com/acme/8c3f0a52-0e2b-4b55-9a4e-0d3f6b0f6a11', 'ashby'],
    ['https://boards.greenhouse.io/acme/jobs/4012345', 'greenhouse'],
    ['https://job-boards.greenhouse.io/acme/jobs/4012345', 'greenhouse'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/4012345', 'greenhouse'],
    ['https://jobs.lever.co/acme/8c3f0a52-0e2b-4b55-9a4e-0d3f6b0f6a11/apply', 'lever'],
    ['https://jobs.eu.lever.co/acme/8c3f0a52-0e2b-4b55-9a4e-0d3f6b0f6a11', 'lever'],
  ])('routes %s to %s', (url, ats) => {
    const sel = selectAdapter(url);
    expect(sel.ok && sel.adapter.ats).toBe(ats);
  });

  it.each([
    'https://acme.com/careers/123',
    'https://www.linkedin.com/jobs/view/3912345678',
    'https://jobs.lever.co.evil.example/acme/x',
    'https://evil.example/boards.greenhouse.io/acme/jobs/1',
    'file:///tmp/form.html',
    'not a url',
    '',
  ])('rejects %s as unsupported-ats', (url) => {
    expect(selectAdapter(url)).toEqual({ ok: false, reason: 'unsupported-ats' });
  });
});

describe('classifyField', () => {
  it('puts voluntary demographic labels and sections ahead of everything else', () => {
    expect(classifyField({ label: 'Gender', type: 'select', hint: '' })).toBe(
      'self-identification',
    );
    expect(classifyField({ label: 'Are you a protected veteran?', type: 'radio', hint: '' })).toBe(
      'self-identification',
    );
    expect(classifyField({ label: 'Anything', type: 'text', hint: 'eeoc_fields' })).toBe(
      'self-identification',
    );
    expect(classifyField({ label: 'Email', type: 'text', hint: 'main_fields' })).toBe('standard');
    expect(classifyField({ label: 'Describe a hard bug', type: 'textarea', hint: '' })).toBe(
      'free-text',
    );
  });
});

describe.each(VENDORS)('$name adapter on its fixture', (v) => {
  const form = (query = '') => fixtureUrl(v.dir, 'form.html', query);

  it('detects its own hosts only', () => {
    const own = {
      greenhouse: 'https://boards.greenhouse.io/a/jobs/1',
      lever: 'https://jobs.lever.co/a/b',
      ashby: 'https://jobs.ashbyhq.com/a/b',
    }[v.name]!;
    expect(v.adapter.detect(own)).toBe(true);
    expect(v.adapter.detect('https://example.com/a/jobs/1')).toBe(false);
  });

  it('describes every question with required flags and classifications', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, form());
      const fields = await v.adapter.fields(page);
      expect(ids(fields)).toEqual(Object.keys(v.expected).sort());
      for (const f of fields) {
        const [required, classification, type] = v.expected[f.id]!;
        expect({ id: f.id, required, classification, type }).toEqual({
          id: f.id,
          required: f.required,
          classification: f.classification,
          type: f.type,
        });
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.label).not.toMatch(/\*|✱/);
      }
      expect(
        fields
          .filter((f) => f.classification === 'self-identification')
          .map((f) => f.id)
          .sort(),
      ).toEqual([...v.selfId].sort());
      const free = fields.find((f) => f.classification === 'free-text' && f.type === 'textarea');
      expect(free?.maxLength).toBeGreaterThan(0);
      expect(fields.find((f) => f.type === 'select')?.options?.length).toBeGreaterThan(0);
    });
  });

  it('fills, attaches the resume, submits, and sees the confirmation', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, form());
      expect(await v.adapter.requiresAccount(page)).toBe(false);
      expect(await v.adapter.findCaptcha(page)).toBeNull();
      expect(await v.adapter.confirmed(page)).toBe(false);
      // The resume goes in first: a stepped form checks its required upload on Next.
      await v.adapter.attachResume(page, PDF);
      await v.adapter.fill(page, v.values);

      // Self-identification answers are ignored even when a value is supplied.
      for (const id of v.selfId) {
        const value = await page.locator(`[id="${id}"], [name="${id}"]`).first().inputValue();
        expect(value, id).toBe('');
      }
      expect(
        await page
          .locator('input[type="file"][required]')
          .first()
          .evaluate((el: { files: { length: number } }) => el.files.length),
      ).toBe(1);

      await v.adapter.submit(page);
      expect(await v.adapter.confirmed(page)).toBe(true);
    });
  });

  it('attaches nothing and does not fail when the form has no resume field', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, form());
      await page.evaluate('document.querySelectorAll("input[type=file]").forEach(e => e.remove())');
      await expect(v.adapter.attachResume(page, PDF)).resolves.toBeUndefined();
    });
  });

  it('reports a required field it cannot map, with a stored screenshot', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, form('?unmapped'));
      const fields = await v.adapter.fields(page);
      const upload = fields.find(
        (f) => f.type === 'file' && f.classification !== 'resume' && f.required,
      );
      expect(upload, 'required non-resume upload present').toBeDefined();

      // Every other required field has a value; the upload can never be mapped.
      const unmapped = findUnmappedRequired(fields, v.values);
      expect(unmapped.map((f) => f.id)).toEqual([upload!.id]);

      const { ctx, stored } = fakeCtx();
      const outcome = await reportUnmappedFields(page, ctx, fields, v.values);
      expect(outcome).toMatchObject({
        reason: 'unmapped-field',
        fields: [{ id: upload!.id, label: upload!.label }],
        screenshotKey: 'tenants/tenant-1/applications/app-1/failure-1.png',
      });
      const png = stored.get(outcome!.screenshotKey!);
      expect(Buffer.from(png!).subarray(0, 4)).toEqual(PNG_MAGIC);
    });
  });

  it('returns null when every required field has a value', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, form());
      const fields = await v.adapter.fields(page);
      const values: FieldValues = { ...v.values };
      for (const f of fields) {
        if (f.required && f.classification !== 'resume' && values[f.id] === undefined) {
          values[f.id] = f.type === 'checkbox' ? true : 'x';
        }
      }
      const { ctx, stored } = fakeCtx();
      expect(await reportUnmappedFields(page, ctx, fields, values)).toBeNull();
      expect(stored.size).toBe(0);
    });
  });

  it('exposes a CAPTCHA after submit, and enter/cleared work against the widget', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, form('?captcha'));
      expect(await v.adapter.findCaptcha(page)).toBeNull();
      // The resume goes in first: a stepped form checks its required upload on Next.
      await v.adapter.attachResume(page, PDF);
      await v.adapter.fill(page, v.values);
      await v.adapter.submit(page);
      expect(await v.adapter.confirmed(page)).toBe(false);

      const captcha = await v.adapter.findCaptcha(page);
      expect(captcha).not.toBeNull();
      const shot = await captcha!.screenshot();
      expect(Buffer.isBuffer(shot)).toBe(true);
      expect(shot.subarray(0, 4)).toEqual(PNG_MAGIC);
      expect(await captcha!.cleared()).toBe(false);

      await captcha!.enter('WRONG');
      expect(await captcha!.cleared()).toBe(false);
      await captcha!.enter('7k3q');
      expect(await captcha!.cleared()).toBe(true);
      expect(await v.adapter.findCaptcha(page)).toBeNull();

      await v.adapter.submit(page);
      expect(await v.adapter.confirmed(page)).toBe(true);
    });
  });

  it('stores a failure screenshot under the application folder', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, form());
      const { ctx, stored } = fakeCtx();
      expect(await screenshotOnFailure(page, ctx, '2')).toBe(
        'tenants/tenant-1/applications/app-1/failure-2.png',
      );
      expect(stored.size).toBe(1);
    });
  });
});

describe.each(VENDORS.filter((v) => v.name !== 'lever'))('$name accounts', (v) => {
  const account = () => fixtureUrl(v.dir, 'account.html');

  it('recognizes the sign-up page, fills it, and leaves the form page alone', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, account());
      expect(await v.adapter.requiresAccount(page)).toBe(true);
      await v.adapter.signUp(page, {
        email: 'candidate@example.com',
        password: 'Zk3Qm9Lr2Xv7Bt5Nc8Wd4Hy6',
      });
      expect(page.url()).toMatch(/check-email\.html$/);
    });
    await withPage(async (page) => {
      await v.adapter.load(page, fixtureUrl(v.dir, 'form.html'));
      expect(await v.adapter.requiresAccount(page)).toBe(false);
    });
  });

  it('signIn returns ok with the right password', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, account());
      const outcome = await v.adapter.signIn(page, {
        username: 'candidate@example.com',
        password: 'correct-horse-battery',
      });
      expect(outcome).toBe('ok');
      expect(await v.adapter.requiresAccount(page)).toBe(false);
      expect((await v.adapter.fields(page)).length).toBeGreaterThan(5);
    });
  });

  it('signIn returns rejected with a wrong password', async () => {
    await withPage(async (page) => {
      await v.adapter.load(page, account());
      const outcome = await v.adapter.signIn(page, {
        username: 'candidate@example.com',
        password: 'wrong-password-123',
      });
      expect(outcome).toBe('rejected');
      expect(await v.adapter.requiresAccount(page)).toBe(true);
    });
  });
});

describe('lever has no accounts', () => {
  it('never requires one and refuses account flows', async () => {
    await withPage(async (page) => {
      await leverAdapter.load(page, fixtureUrl('lever', 'form.html'));
      expect(await leverAdapter.requiresAccount(page)).toBe(false);
      await expect(
        leverAdapter.signUp(page, { email: 'a@example.com', password: 'x' }),
      ).rejects.toThrow(/do not use candidate accounts/);
    });
  });
});
