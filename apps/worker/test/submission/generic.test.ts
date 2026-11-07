import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SubmissionFailure } from '../../src/submission/failure';
import { ashbyAdapter, greenhouseAdapter, leverAdapter } from '../../src/submission/adapters';
import { VendorAdapter, type VendorHints } from '../../src/submission/adapters/common';
import {
  probePage,
  scanPage,
  stuck,
  withFreshScan,
  type Question,
} from '../../src/submission/adapters/generic';
import {
  classifyFields,
  resolveStandardFields,
  standardKeyFor,
} from '../../src/submission/answers';
import type { FieldDescriptor, FormAdapter } from '../../src/submission/types';
import { PROFILE } from '../fixtures/submission';

const FORMS = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/forms');
const urlOf = (dir: string, file: string) => pathToFileURL(join(FORMS, dir, file)).toString();
const PDF = { filename: 'resume.pdf', bytes: Buffer.from('%PDF-1.4\n%fixture\n') };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** A vendor that hints nothing: every behaviour below comes from the page itself. */
const bareHints: VendorHints = {
  ats: 'greenhouse',
  hosts: /^never\.example$/,
  confirmation: { selector: '#no-such-confirmation' },
  account: null,
};
const bare = new VendorAdapter(bareHints);

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

async function open(page: Page, file: string, adapter: FormAdapter = bare, dir = 'generic') {
  await adapter.load(page, urlOf(dir, file));
}

const byLabel = (fields: FieldDescriptor[], label: string) => {
  const f = fields.find((x) => x.label === label);
  if (!f) throw new Error(`no field "${label}" in ${fields.map((x) => x.label).join(' | ')}`);
  return f;
};

type Row = [string, FieldDescriptor['type'], boolean, FieldDescriptor['classification']];
const rows = (fields: FieldDescriptor[]): Row[] =>
  fields.map((f) => [f.label, f.type, f.required, f.classification]);

// ---------------------------------------------------------------------------------------------
// Static scans of the three real captures (2026-11-07). The numbers in the test names were
// confirmed against the fixtures. The captures are static HTML, so a react-select menu cannot
// open: those comboboxes are reported as `text` here and carry their options only on a live page.
// ---------------------------------------------------------------------------------------------

describe('real captures', () => {
  it('greenhouse job-boards (Anthropic): 25 controls -> 25 questions incl. 3 self-identification', async () => {
    await withPage(async (page) => {
      await open(page, 'greenhouse-jobboards.html', greenhouseAdapter, 'real');
      expect((await scanPage(page)).controls).toBe(25);
      const fields = await greenhouseAdapter.fields(page);
      expect(rows(fields)).toEqual([
        ['First Name', 'text', true, 'standard'],
        ['Last Name', 'text', true, 'standard'],
        ['Email', 'text', true, 'standard'],
        ['Country', 'text', false, 'standard'],
        ['Phone', 'text', false, 'standard'],
        ['Resume/CV', 'file', false, 'resume'],
        ['(Optional) Personal Preferences', 'text', false, 'free-text'],
        ['Website', 'text', false, 'standard'],
        [
          'Are you open to working in-person in one of our offices 25% of the time?',
          'text',
          true,
          'free-text',
        ],
        [
          'When is the earliest you would want to start working with us?',
          'text',
          false,
          'free-text',
        ],
        [
          'Do you have any deadlines or timeline considerations we should be aware of?',
          'text',
          false,
          'free-text',
        ],
        ['AI Policy for Application', 'text', true, 'free-text'],
        ['Why Anthropic?', 'textarea', true, 'free-text'],
        ['Do you require visa sponsorship?', 'text', true, 'standard'],
        [
          "Will you now or will you in the future require employment visa sponsorship to work in the country in which the job you're applying for is located?",
          'text',
          true,
          'standard',
        ],
        ['Additional Information', 'textarea', false, 'free-text'],
        ['LinkedIn Profile', 'text', false, 'standard'],
        ['Are you open to relocation for this role?', 'text', true, 'standard'],
        [
          'What is the address from which you plan on working? If you would need to relocate, please type "relocating".',
          'text',
          false,
          'standard',
        ],
        ['Have you ever interviewed at Anthropic before?', 'text', true, 'free-text'],
        ['Please read the arbitration agreement below', 'text', true, 'free-text'],
        ['Agreement to Arbitrate', 'text', true, 'free-text'],
        ['Gender', 'text', false, 'self-identification'],
        ['Are you Hispanic/Latino?', 'text', false, 'self-identification'],
        ['Veteran Status', 'text', false, 'self-identification'],
      ]);
      expect(fields.filter((f) => f.classification === 'self-identification')).toHaveLength(3);
      // The hidden react-select twin and the Toggle flyout buttons are not questions.
      expect(fields.map((f) => f.id)).toContain('question_19145888008');
      expect(await greenhouseAdapter.notices!(page)).toEqual([]);
    });
  }, 60_000);

  it('greenhouse: the AI policy question carries its description (rule 22)', async () => {
    await withPage(async (page) => {
      await open(page, 'greenhouse-jobboards.html', greenhouseAdapter, 'real');
      const fields = await greenhouseAdapter.fields(page);
      const policy = byLabel(fields, 'AI Policy for Application');
      expect(policy.description).toMatch(/^We believe that AI will have a transformative impact/);
      expect(policy.description).toMatch(/confirm your understanding by selecting .Yes\..$/);
      expect(policy.description).not.toContain('AI Policy for Application');
      expect(byLabel(fields, '(Optional) Personal Preferences').description).toBe(
        'How do you pronounce your name?',
      );
      // No placeholder or error text leaks in as a description.
      expect(byLabel(fields, 'Country').description).toBeUndefined();
      expect(fields.every((f) => (f.description ?? '').length <= 1000)).toBe(true);
      // Rule 24b: its description makes it an acknowledgement, answered Yes.
      const [classified] = await classifyFields([policy]);
      expect(classified).toMatchObject({ classification: 'standard', standardKey: 'consent' });
      expect(resolveStandardFields({ profile: PROFILE }, [classified!])[0]).toMatchObject({
        status: 'filled',
        value: 'Yes',
      });
    });
  }, 60_000);

  it('ashby: "When can you start a new role?" is a date question the answer step reads as start_date (rule 23)', async () => {
    await withPage(async (page) => {
      await open(page, 'ashby.html', ashbyAdapter, 'real');
      const fields = await ashbyAdapter.fields(page);
      const start = byLabel(fields, 'When can you start a new role?');
      expect(start.type).toBe('date');
      const [classified] = await classifyFields([start]);
      expect(classified).toMatchObject({ classification: 'standard', standardKey: 'start_date' });
    });
  }, 60_000);

  it('ashby (OpenAI): 30 controls -> 16 questions incl. 3 yes/no, 3 self-identification radio groups, 2 consent checkboxes', async () => {
    await withPage(async (page) => {
      await open(page, 'ashby.html', ashbyAdapter, 'real');
      expect((await scanPage(page)).controls).toBe(30);
      const fields = await ashbyAdapter.fields(page);
      expect(
        byLabel(
          fields,
          'Will you now or in the future require sponsorship for employment visa status in this country?',
        ).description,
      ).toBe(
        'We may provide immigration and sponsorship support to new employees based on their unique circumstances.',
      );
      expect(rows(fields)).toEqual([
        ['Legal Name', 'text', true, 'standard'],
        ['Preferred Name (if applicable)', 'text', false, 'free-text'],
        ['Email', 'text', true, 'standard'],
        ['Resume', 'file', true, 'resume'],
        ['Phone Number', 'text', true, 'standard'],
        ['Where are you currently located?', 'text', true, 'standard'],
        ['When can you start a new role?', 'date', true, 'free-text'],
        [
          'Are you authorized to work in the country where the job is located?',
          'radio',
          true,
          'standard',
        ],
        [
          'Will you now or in the future require sponsorship for employment visa status in this country?',
          'radio',
          true,
          'standard',
        ],
        [
          'Are you able to work from our US office three days per week?',
          'radio',
          true,
          'free-text',
        ],
        ['Additional Information', 'textarea', false, 'free-text'],
        ['Applicant Arbitration Agreement Acknowledgement', 'checkbox', true, 'free-text'],
        [
          expect.stringMatching(
            /^I hereby certify that I have not knowingly withheld/,
          ) as unknown as string,
          'checkbox',
          true,
          'free-text',
        ],
        ['Gender', 'radio', false, 'self-identification'],
        ['Race', 'radio', false, 'self-identification'],
        ['Veteran Status', 'radio', false, 'self-identification'],
      ]);
      const yesNo = fields.filter((f) => f.options?.join() === 'Yes,No');
      expect(yesNo).toHaveLength(3);
      expect(byLabel(fields, 'Gender').options).toEqual([
        'Male',
        'Female',
        'Decline to self-identify',
      ]);
      expect(byLabel(fields, 'Race').options).toHaveLength(8);
      // The "Autofill from resume" upload is not a question; the Resume field is the resume input.
      expect(fields.filter((f) => f.type === 'file')).toHaveLength(1);
      expect(await ashbyAdapter.notices!(page)).toEqual([
        { kind: 'application-limit', max: 5, days: 180 },
      ]);
    });
  }, 60_000);

  it('lever (Palantir): 59 controls -> 22 questions, the language group as ONE, the consent radio, 2 native selects', async () => {
    await withPage(async (page) => {
      await open(page, 'lever.html', leverAdapter, 'real');
      expect((await scanPage(page)).controls).toBe(59);
      const fields = await leverAdapter.fields(page);
      expect(rows(fields)).toEqual([
        ['Resume/CV', 'file', true, 'resume'],
        ['Full name', 'text', true, 'standard'],
        ['Email', 'text', true, 'standard'],
        ['Phone', 'text', false, 'standard'],
        ['Current location', 'text', true, 'standard'],
        ['Current company', 'text', false, 'standard'],
        ['LinkedIn URL', 'text', false, 'standard'],
        ['GitHub URL', 'text', false, 'standard'],
        ['Portfolio URL', 'text', false, 'standard'],
        ['Language Skill(s) (Check all that apply)', 'checkbox', true, 'free-text'],
        ['Preferred Name | What would you like us to call you?', 'text', false, 'free-text'],
        ['Name Pronunciation | How do you pronounce your name?', 'text', false, 'free-text'],
        [
          'Are you legally authorized to work in the country for which you are applying?',
          'radio',
          true,
          'standard',
        ],
        [
          'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, etc.)?',
          'radio',
          true,
          'standard',
        ],
        [
          expect.stringMatching(
            /^Which university are you currently attending/,
          ) as unknown as string,
          'select',
          true,
          'free-text',
        ],
        ['Please tell us how you heard about this opportunity.', 'select', true, 'free-text'],
        [
          'What has been your favorite project or proudest accomplishment? Why?',
          'textarea',
          false,
          'free-text',
        ],
        ['Why do you want to work at Palantir?', 'textarea', false, 'free-text'],
        [
          expect.stringMatching(
            /^As part of our interview process, we may use AI notetakers/,
          ) as unknown as string,
          'radio',
          true,
          'standard',
        ],
        ['Are you a Singapore citizen?', 'radio', true, 'free-text'],
        ['Are you a Singapore permanent resident?', 'radio', true, 'free-text'],
        ['Additional information', 'textarea', false, 'free-text'],
      ]);
      const languages = fields.find((f) => f.label.startsWith('Language Skill'))!;
      expect(languages.options).toHaveLength(33);
      expect(languages.options).toContain('English (ENG)');
      const consent = fields.find((f) => f.label.startsWith('As part of our interview'))!;
      expect(consent.options).toEqual(['Yes, I consent', 'No, I do not consent']);
      const selects = fields.filter((f) => f.type === 'select');
      expect(selects).toHaveLength(2);
      expect(selects.map((s) => s.options!.length)).toEqual([26, 20]);
      expect(await leverAdapter.notices!(page)).toEqual([]);
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Interactive synthetic fixtures: one per control kind. Each fills and verifies (rule 9).
// ---------------------------------------------------------------------------------------------

describe('control kinds', () => {
  it('react-select-like combobox with a portal menu, and a large list', async () => {
    await withPage(async (page) => {
      await open(page, 'combobox.html');
      const fields = await bare.fields(page);
      const colour = byLabel(fields, 'Favourite colour');
      expect(colour).toMatchObject({
        type: 'select',
        required: true,
        options: ['Red', 'Green', 'Blue', 'Blue-green'],
      });
      const country = byLabel(fields, 'Country');
      expect(country).toMatchObject({ type: 'select', required: false, hint: 'large-list' });
      expect(country.options).toBeUndefined();

      // The exact option wins over one that merely starts with the value.
      await bare.fill(page, { [colour.id]: 'Blue', [country.id]: 'Portugal' });
      expect(await page.locator('#app').getAttribute('data-colour')).toBe('Blue');
      expect(await page.locator('#app').getAttribute('data-country')).toBe('Portugal');
      expect(await page.locator('#colour-value').textContent()).toBe('Blue');
      // The menu is closed again.
      expect(await page.locator('[role=listbox]').count()).toBe(0);
    });
  }, 60_000);

  it('a combobox value that matches nothing: optional is left blank, required is an unmapped-field', async () => {
    await withPage(async (page) => {
      await open(page, 'combobox.html');
      const fields = await bare.fields(page);
      const colour = byLabel(fields, 'Favourite colour');
      const country = byLabel(fields, 'Country');
      // The required colour is answered; the optional country has no match and stays blank.
      await expect(
        bare.fill(page, { [colour.id]: 'Red', [country.id]: 'Atlantis' }),
      ).resolves.toBeUndefined();
      expect(await page.locator('#app').getAttribute('data-country')).toBeNull();
      const err = await bare.fill(page, { [colour.id]: 'Purple' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionFailure);
      expect((err as SubmissionFailure).reason).toBe('unmapped-field');
      expect((err as SubmissionFailure).detail).toMatchObject({
        field: 'Favourite colour',
        fields: [{ id: 'colour', label: 'Favourite colour' }],
      });
    });
  }, 60_000);

  it('an Ashby-like yes/no button pair (orphan label, backing checkbox)', async () => {
    await withPage(async (page) => {
      await open(page, 'yesno.html');
      const fields = await bare.fields(page);
      expect(fields).toHaveLength(1);
      const q = fields[0]!;
      expect(q).toMatchObject({
        label: 'Are you authorized to work here?',
        type: 'radio',
        required: true,
        options: ['Yes', 'No'],
      });
      await bare.fill(page, { [q.id]: true });
      expect(await page.locator('#app').getAttribute('data-answer')).toBe('yes');
      expect(await page.locator('[data-option=yes]').getAttribute('aria-pressed')).toBe('true');
      await bare.fill(page, { [q.id]: 'No' });
      expect(await page.locator('#app').getAttribute('data-answer')).toBe('no');
      expect(await page.locator('[data-option=yes]').getAttribute('aria-pressed')).toBe('false');
    });
  }, 60_000);

  it('an autocomplete that filters on typing: picks the option containing the text, else keeps the typed text', async () => {
    await withPage(async (page) => {
      await open(page, 'autocomplete.html');
      const fields = await bare.fields(page);
      const place = byLabel(fields, 'Where are you located?');
      const other = byLabel(fields, 'Other place');
      expect(place).toMatchObject({ type: 'text', required: true });
      await bare.fill(page, { [place.id]: 'Lisbon, Portugal', [other.id]: 'Zzzz' });
      expect(await page.locator('[data-name=place]').inputValue()).toBe('Lisbon, Portugal');
      expect(await page.locator('[data-name=other]').inputValue()).toBe('Zzzz');
    });
  }, 60_000);

  it('a date input with a picker: typed in the placeholder format, picker closed', async () => {
    await withPage(async (page) => {
      await open(page, 'date.html');
      const fields = await bare.fields(page);
      const start = byLabel(fields, 'Start date');
      const native = byLabel(fields, 'Native date');
      expect(start).toMatchObject({ type: 'date', required: true });
      expect(native.type).toBe('date');
      await bare.fill(page, { [start.id]: '2026-03-15', [native.id]: 'March 4, 2027' });
      expect(await page.locator('#start').inputValue()).toBe('15/03/2026');
      expect(await page.locator('#picker').isVisible()).toBe(false);
      expect(await page.locator('#native').inputValue()).toBe('2027-03-04');
    });
  }, 60_000);

  it('a date picker without a format hint takes the ISO value as MM/DD/YYYY, picker closed', async () => {
    await withPage(async (page) => {
      await open(page, 'date-nofmt.html');
      const fields = await bare.fields(page);
      const start = byLabel(fields, 'Earliest start');
      expect(start.type).toBe('date');
      await bare.fill(page, { [start.id]: '2026-12-01' });
      expect(await page.locator('#start').inputValue()).toBe('12/01/2026');
      expect(await page.locator('#picker').isVisible()).toBe(false);
    });
  }, 60_000);

  it('question descriptions: aria-describedby, hint siblings, in-box text; never the label or options (rule 22)', async () => {
    await withPage(async (page) => {
      await open(page, 'described.html');
      const fields = await bare.fields(page);
      expect(byLabel(fields, 'AI policy').description).toBe(
        'Please review our guidelines and confirm by typing "Yes".',
      );
      expect(byLabel(fields, 'Why us?').description).toBe('Two or three sentences are plenty.');
      expect(byLabel(fields, 'Plain question').description).toBeUndefined();
      expect(byLabel(fields, 'Long note').description).toHaveLength(1000);
      const remote = byLabel(fields, 'Remote?');
      expect(remote.description).toBe('Tell us where you would work from.');
      expect(remote.options).toEqual(['Yes', 'No']);
    });
  }, 60_000);

  it('an international phone widget: country set first, national digits typed', async () => {
    await withPage(async (page) => {
      await open(page, 'phone.html');
      const fields = await bare.fields(page);
      const country = byLabel(fields, 'Country');
      const phone = byLabel(fields, 'Phone');
      await bare.fill(page, { [country.id]: 'United Kingdom', [phone.id]: '+44 20 7946 0958' });
      expect(await page.locator('.iti__selected-dial-code').textContent()).toBe('+44');
      expect(await page.locator('#phone').inputValue()).toBe('2079460958');
    });
    await withPage(async (page) => {
      await open(page, 'phone.html');
      const phone = byLabel(await bare.fields(page), 'Phone');
      // No country to set: the number is typed as given.
      await bare.fill(page, { [phone.id]: '+351 912 345 678' });
      expect(await page.locator('#phone').inputValue()).toBe('+351 912 345 678');
    });
  }, 60_000);

  it('a hidden file input behind a drop zone takes the resume; a drop zone with no input is an unmapped-field', async () => {
    await withPage(async (page) => {
      await open(page, 'dropzone.html');
      const fields = await bare.fields(page);
      expect(byLabel(fields, 'Resume/CV')).toMatchObject({
        type: 'file',
        classification: 'resume',
      });
      await bare.attachResume(page, PDF);
      expect(await page.locator('#picked').textContent()).toBe('resume.pdf');
    });
    await withPage(async (page) => {
      await open(page, 'dropzone-noinput.html');
      const err = await bare.attachResume(page, PDF).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionFailure);
      expect((err as SubmissionFailure).detail).toMatchObject({ field: 'resume' });
    });
  }, 60_000);
});

describe('required detection (rule 6)', () => {
  it('finds an asterisk in an aria-hidden span, a _required_ class, hidden required twins (aria, type, attribute, CSS) and aria-required', async () => {
    await withPage(async (page) => {
      await open(page, 'required.html');
      const fields = await bare.fields(page);
      expect(fields.map((f) => [f.label, f.required])).toEqual([
        ['Alpha', true],
        ['Beta', true],
        ['Gamma', true],
        ['Delta', false],
        ['Epsilon', true],
        // hidden required twins, hidden by type, by the hidden attribute and by CSS
        ['Zeta', true],
        ['Eta', true],
        ['Theta', true],
      ]);
    });
  }, 60_000);
});

describe('submit, confirmation and CAPTCHA (rules 10, 12, 13)', () => {
  it('a submit that is still disabled after the fill is an unmapped-field naming submit', async () => {
    await withPage(async (page) => {
      await open(page, 'submit-disabled.html');
      const [name] = await bare.fields(page);
      await bare.fill(page, { [name!.id]: 'Mara Quill' });
      const err = await bare.submit(page).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionFailure);
      expect((err as SubmissionFailure).reason).toBe('unmapped-field');
      expect((err as SubmissionFailure).detail).toMatchObject({
        field: 'Submit',
        fields: [{ id: 'submit' }],
      });
    });
  }, 60_000);

  it('a validation error after submit is form-rejected, with the error texts', async () => {
    await withPage(async (page) => {
      await open(page, 'rejected.html');
      const [email] = await bare.fields(page);
      await bare.fill(page, { [email!.id]: 'not-an-email' });
      const err = await bare.submit(page).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionFailure);
      expect((err as SubmissionFailure).reason).toBe('form-rejected');
      const errors = (err as SubmissionFailure).detail.errors as string[];
      expect(errors.join(' | ')).toContain('Enter a valid email address');
    });
  }, 60_000);

  it('confirmation by text: the form is replaced by a thank-you message', async () => {
    await withPage(async (page) => {
      await open(page, 'confirm-text.html');
      const [name] = await bare.fields(page);
      expect(await bare.confirmed(page)).toBe(false);
      await bare.fill(page, { [name!.id]: 'Mara Quill' });
      await bare.submit(page);
      expect(await bare.confirmed(page)).toBe(true);
      expect(await page.locator('h2').textContent()).toBe('Thank you for applying!');
    });
  }, 60_000);

  it('confirmation by the vendor URL', async () => {
    const withUrl = new VendorAdapter({
      ...bareHints,
      confirmation: { selector: '#no-such-confirmation', url: /confirm-url-done\.html$/ },
    });
    await withPage(async (page) => {
      await open(page, 'confirm-url.html', withUrl);
      const [name] = await withUrl.fields(page);
      expect(await withUrl.confirmed(page)).toBe(false);
      await withUrl.fill(page, { [name!.id]: 'Mara Quill' });
      await withUrl.submit(page);
      expect(page.url()).toMatch(/confirm-url-done\.html$/);
      expect(await withUrl.confirmed(page)).toBe(true);
    });
  }, 60_000);

  it('an iframe challenge is a CAPTCHA that has no image to solve; an invisible badge is not', async () => {
    await withPage(async (page) => {
      await open(page, 'frame-captcha.html');
      const [name] = await bare.fields(page);
      expect(await bare.findCaptcha(page)).toBeNull();
      await bare.fill(page, { [name!.id]: 'Mara Quill' });
      await bare.submit(page);
      const captcha = await bare.findCaptcha(page);
      expect(captcha).not.toBeNull();
      expect(captcha!.challenge).toBe('frame');
      const shot = await captcha!.screenshot();
      expect(shot.subarray(0, 4)).toEqual(PNG_MAGIC);
      // A full-page capture, not the widget region.
      const viewport = page.viewportSize()!;
      const png = { w: shot.readUInt32BE(16), h: shot.readUInt32BE(20) };
      expect(png.h).toBeGreaterThanOrEqual(viewport.height);
      expect(await captcha!.cleared()).toBe(false);
      // The visible frame stays after a provider marks it solved: the response token is the evidence.
      await page.evaluate(
        "document.querySelector('[name=h-captcha-response]').value = 'P0_eyJ0eXAi'",
      );
      expect(await captcha!.cleared()).toBe(true);
      expect(await bare.findCaptcha(page)).toBeNull();
    });
    await withPage(async (page) => {
      await open(page, 'badge-only.html');
      expect(await bare.findCaptcha(page)).toBeNull();
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Fix pass after the live scan and the review (rules 19-21 and the review findings)
// ---------------------------------------------------------------------------------------------

async function fillError(page: Page, values: Record<string, string | boolean | string[]>) {
  const err = await bare.fill(page, values).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SubmissionFailure);
  return err as SubmissionFailure;
}

describe('hydration (rule 19)', () => {
  it('a form replaced 700 ms after load: the first fill still lands on the live elements', async () => {
    await withPage(async (page) => {
      await open(page, 'hydration.html');
      const fields = await bare.fields(page);
      const name = byLabel(fields, 'Full name');
      await bare.fill(page, { [name.id]: 'Mara Quill', [byLabel(fields, 'Email').id]: 'm@q.io' });
      expect(await page.locator('#name').inputValue()).toBe('Mara Quill');
      expect(await page.locator('#email').inputValue()).toBe('m@q.io');
    });
  }, 60_000);

  it('a scan whose elements were replaced is rescanned before acting (withFreshScan)', async () => {
    await withPage(async (page) => {
      await open(page, 'hydration.html');
      const stale = await scanPage(page);
      await page.evaluate('window.rehydrate()');
      expect(await page.locator('[data-wma-c]').count()).toBe(0);
      const live = await withFreshScan(page, stale, async (scan) => scan);
      expect(live).not.toBe(stale);
      expect(live.questions.map((q) => q.id)).toEqual(stale.questions.map((q) => q.id));
      expect(await page.locator('[data-wma-c]').count()).toBeGreaterThan(0);
      // A scan that is still live is used as it is.
      expect(await withFreshScan(page, live, async (scan) => scan)).toBe(live);
    });
  }, 60_000);
});

describe('native selects (rule 20, review)', () => {
  it('a 200-option select is a large list with no options; it is filled by the option containing the value', async () => {
    await withPage(async (page) => {
      await open(page, 'large-select.html');
      const fields = await bare.fields(page);
      const country = byLabel(fields, 'Country of residence');
      expect(country).toMatchObject({ type: 'select', required: true, hint: 'large-list' });
      expect(country.options).toBeUndefined();
      const region = byLabel(fields, 'Region');
      expect(region.options).toEqual(['United States', 'Canada']);
      expect(region.hint).toBeUndefined();
      await bare.fill(page, { [country.id]: 'Portugal', [region.id]: 'Canada' });
      expect(await page.locator('#country').inputValue()).toBe('pt');
    });
  }, 60_000);

  it('a large list with no matching option is an unmapped-field when required', async () => {
    await withPage(async (page) => {
      await open(page, 'large-select.html');
      const fields = await bare.fields(page);
      const err = await fillError(page, {
        [byLabel(fields, 'Country of residence').id]: 'Atlantis',
        [byLabel(fields, 'Region').id]: 'Canada',
      });
      expect(err.reason).toBe('unmapped-field');
      expect(err.detail).toMatchObject({ field: 'Country of residence' });
    });
  }, 60_000);

  it('a select chosen by value verifies by value (value us, label United States)', async () => {
    await withPage(async (page) => {
      await open(page, 'large-select.html');
      const fields = await bare.fields(page);
      await bare.fill(page, {
        [byLabel(fields, 'Country of residence').id]: 'pt',
        [byLabel(fields, 'Region').id]: 'us',
      });
      expect(await page.locator('#region').inputValue()).toBe('us');
    });
  }, 60_000);
});

describe('combobox value ownership (review)', () => {
  it("a neighbour's selected value does not verify this question", async () => {
    await withPage(async (page) => {
      await open(page, 'combobox-owner.html');
      const fields = await bare.fields(page);
      const second = byLabel(fields, 'Second choice');
      // "Alpha" is selected in the first combobox only; the second has no such option.
      const err = await fillError(page, { [second.id]: 'Alpha' });
      expect(err.reason).toBe('unmapped-field');
      expect(err.detail.fields).toEqual([{ id: second.id, label: 'Second choice' }]);
      await bare.fill(page, { [second.id]: 'Gamma' });
      expect(await page.locator('#b-value').textContent()).toBe('Gamma');
    });
  }, 60_000);

  it('search text left in a select-style combobox is not a committed selection', async () => {
    await withPage(async (page) => {
      await open(page, 'combobox-noopts.html');
      const fields = await bare.fields(page);
      const team = byLabel(fields, 'Team');
      const err = await fillError(page, { [team.id]: 'Platform' });
      expect(err.reason).toBe('unmapped-field');
      expect(err.detail).toMatchObject({ field: 'Team' });
      expect(await page.locator('#c').inputValue()).toBe('Platform');
    });
  }, 60_000);

  it('a free-text autocomplete keeps its typed text and verifies', async () => {
    await withPage(async (page) => {
      await open(page, 'autocomplete.html');
      const fields = await bare.fields(page);
      const other = byLabel(fields, 'Other place');
      const place = byLabel(fields, 'Where are you located?');
      await bare.fill(page, { [place.id]: 'Porto, Portugal', [other.id]: 'Somewhere new' });
      expect(await page.locator('[data-name=other]').inputValue()).toBe('Somewhere new');
    });
  }, 60_000);
});

describe('self-identification by section id (review)', () => {
  it('a section known only by id="eeoc_fields" is self-identification and is not filled', async () => {
    await withPage(async (page) => {
      await open(page, 'section-id.html');
      const fields = await bare.fields(page);
      expect(byLabel(fields, 'Preferred pronouns').classification).toBe('self-identification');
      expect(byLabel(fields, 'Full name').classification).toBe('standard');
      await bare.fill(page, {
        [byLabel(fields, 'Full name').id]: 'Mara Quill',
        [byLabel(fields, 'Preferred pronouns').id]: 'she/her',
      });
      expect(await page.locator('#pro').inputValue()).toBe('');
    });
  }, 60_000);

  it('"Where are you currently located?" is a location question', () => {
    expect(standardKeyFor('Where are you currently located?')).toBe('location');
    expect(standardKeyFor('Where are you located?*')).toBe('location');
  });
});

describe('required audit and group answers (review)', () => {
  it('a required question revealed by an answer is reported before submit', async () => {
    await withPage(async (page) => {
      await open(page, 'reveal.html');
      const fields = await bare.fields(page);
      expect(fields.map((f) => f.label)).toEqual(['Full name']);
      const err = await fillError(page, { [fields[0]!.id]: 'Mara Quill' });
      expect(err.reason).toBe('unmapped-field');
      expect(err.detail.fields).toEqual([{ id: 'why', label: 'Why this role?' }]);
    });
  }, 60_000);

  it('a checkbox-group answer that matches no option is rejected and leaves the group as it was', async () => {
    await withPage(async (page) => {
      await open(page, 'checkbox-group.html');
      const fields = await bare.fields(page);
      const langs = byLabel(fields, 'Languages');
      expect(langs).toMatchObject({
        type: 'checkbox',
        required: true,
        options: ['English', 'French'],
      });
      const err = await fillError(page, { [langs.id]: ['German'] });
      expect(err.reason).toBe('unmapped-field');
      expect(await page.locator('input[value=en]').isChecked()).toBe(true);
      await bare.fill(page, { [langs.id]: ['French'] });
      expect(await page.locator('input[value=en]').isChecked()).toBe(false);
      expect(await page.locator('input[value=fr]').isChecked()).toBe(true);
    });
  }, 60_000);

  it('a standalone aria-pressed toggle reads its state from aria-pressed', async () => {
    await withPage(async (page) => {
      await open(page, 'pressed-toggle.html');
      const fields = await bare.fields(page);
      const q = byLabel(fields, 'Keep me informed');
      expect(q).toMatchObject({ type: 'checkbox', required: true });
      await bare.fill(page, { [q.id]: true });
      expect(await page.locator('#sub').getAttribute('aria-pressed')).toBe('true');
      await bare.fill(page, { [q.id]: false }).catch(() => undefined);
      expect(await page.locator('#sub').getAttribute('aria-pressed')).toBe('false');
    });
  }, 60_000);
});

describe('truncated values are not verified (review)', () => {
  const q = (kind: Question['kind'], current: Question['current']): Question => ({
    id: 'x',
    label: 'X',
    kind,
    required: true,
    maxLength: null,
    members: [],
    typeRef: null,
    context: '',
    step: null,
    placeholder: '',
    inputType: '',
    itl: false,
    current,
    isResume: false,
  });
  const intent = (text: string, extra: object = {}) => ({
    text,
    list: [text],
    bool: false,
    ...extra,
  });

  it('a combobox value that is only the start of the intended option does not verify', () => {
    expect(
      stuck(q('combobox', 'United States'), intent('United States Minor Outlying Islands')),
    ).toBe(false);
    expect(stuck(q('combobox', 'United States'), intent('United States'))).toBe(true);
    // a clicked option may be shown with decoration around it
    expect(
      stuck(q('combobox', 'Portugal (+351)'), intent('Portugal', { chosen: 'Portugal' })),
    ).toBe(true);
  });

  it('a phone value must carry all the digits that were typed', () => {
    expect(stuck(q('tel', '8'), intent('+1 555 010 0198', { typed: '5550100198' }))).toBe(false);
    expect(
      stuck(q('tel', '555 010 0198'), intent('+1 555 010 0198', { typed: '5550100198' })),
    ).toBe(true);
  });

  it('a checkbox group whose intended options do not exist never verifies', () => {
    const group = q('checkbox-group', []);
    group.members = [{ ref: 1, label: 'English', value: 'en', dataOption: '' }];
    expect(stuck(group, { text: 'German', list: ['German'], bool: false })).toBe(false);
    expect(stuck(group, { text: '', list: [], bool: false })).toBe(true);
  });

  it('a phone field that keeps one digit is an unmapped-field', async () => {
    await withPage(async (page) => {
      await open(page, 'phone-truncate.html');
      const [phone] = await bare.fields(page);
      const err = await fillError(page, { [phone!.id]: '+1 555 010 0198' });
      expect(err.reason).toBe('unmapped-field');
    });
  }, 60_000);
});

describe('option collection (review)', () => {
  it('waits for options when aria-expanded is on the wrapper and the menu renders late', async () => {
    await withPage(async (page) => {
      await open(page, 'wrapper-combobox.html');
      const fields = await bare.fields(page);
      expect(byLabel(fields, 'Office')).toMatchObject({
        type: 'select',
        options: ['Lisbon', 'Berlin'],
      });
    });
  }, 60_000);

  it('waits for the refreshed results after typing instead of acting on the old rows', async () => {
    await withPage(async (page) => {
      await open(page, 'async-filter.html');
      const fields = await bare.fields(page);
      const skill = byLabel(fields, 'Main skill');
      await bare.fill(page, { [skill.id]: 'Zebra' });
      expect(await page.locator('#skill').inputValue()).toBe('Zebra crossing design');
    });
  }, 60_000);

  it('offers only the options of the active combobox, not a late menu of another', async () => {
    await withPage(async (page) => {
      await open(page, 'scoped-menu.html');
      const fields = await bare.fields(page);
      const second = byLabel(fields, 'Second pick');
      await bare.fill(page, { [second.id]: 'Beta' });
      expect(await page.locator('#app').getAttribute('data-second')).toBe('Pick Beta (second)');
      expect(await page.locator('#app').getAttribute('data-first')).toBeNull();
    });
  }, 60_000);

  it('derives the react-select option prefix from the input id (-input stripped, or the id itself)', async () => {
    await withPage(async (page) => {
      await open(page, 'rs-prefix.html');
      const fields = await bare.fields(page);
      const shift = byLabel(fields, 'Preferred shift');
      const tool = byLabel(fields, 'Preferred tool');
      expect(shift.options).toEqual(['Morning', 'Evening']);
      expect(tool.options).toEqual(['Hammer', 'Saw']);
      await bare.fill(page, { [shift.id]: 'Evening', [tool.id]: 'Saw' });
      expect(await page.locator('#app').getAttribute('data-2')).toBe('Evening');
      expect(await page.locator('#app').getAttribute('data-question_123')).toBe('Saw');
    });
  }, 60_000);
});

describe('anonymous question ids (review)', () => {
  it('ids survive a control inserted ahead of them, and the answers land in the right inputs', async () => {
    await withPage(async (page) => {
      await open(page, 'anon.html');
      const fields = await bare.fields(page);
      const nick = byLabel(fields, 'Nickname');
      const town = byLabel(fields, 'Hometown');
      expect(nick.id).toMatch(/^q:/);
      expect(nick.id).not.toBe(town.id);
      await page.evaluate('window.insertFirst()');
      const again = await bare.fields(page);
      expect(byLabel(again, 'Nickname').id).toBe(nick.id);
      expect(byLabel(again, 'Hometown').id).toBe(town.id);
      expect(again.map((f) => f.label)).toEqual(['Pet name', 'Nickname', 'Hometown']);
      await bare.fill(page, { [nick.id]: 'Quill', [town.id]: 'Porto' });
      const values = await page.evaluate(
        "Array.from(document.querySelectorAll('#rows input')).map((e) => e.value)",
      );
      expect(values).toEqual(['', 'Quill', 'Porto']);
    });
  }, 60_000);
});

describe('confirmation evidence (P1)', () => {
  it('boilerplate that reads like a confirmation is not one: the form hides, then errors -> form-rejected', async () => {
    await withPage(async (page) => {
      await open(page, 'confirm-boilerplate.html');
      const [name] = await bare.fields(page);
      await bare.fill(page, { [name!.id]: 'Mara Quill' });
      const err = await bare.submit(page).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionFailure);
      expect((err as SubmissionFailure).reason).toBe('form-rejected');
      expect(await bare.confirmed(page)).toBe(false);
    });
  }, 60_000);

  it('a thank-you message beside a form that still shows role-based controls is not a confirmation', async () => {
    await withPage(async (page) => {
      await open(page, 'confirm-role-controls.html');
      await page.locator('button[type=submit]').click();
      const probe = await probePage(page);
      expect(probe.thanks).toBe(true);
      expect(probe.controlsLeft).toBe(true);
    });
  }, 60_000);
});

describe('validation errors (review)', () => {
  it('an error that appeared before the click and is still there is form-rejected', async () => {
    await withPage(async (page) => {
      await open(page, 'rejected-persist.html');
      const [email] = await bare.fields(page);
      await bare.fill(page, { [email!.id]: 'not-an-email' });
      expect(await page.locator('#email-error').isVisible()).toBe(true);
      const err = await bare.submit(page).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionFailure);
      expect((err as SubmissionFailure).reason).toBe('form-rejected');
      expect(((err as SubmissionFailure).detail.errors as string[]).join(' | ')).toContain(
        'Enter a valid email address',
      );
    });
  }, 60_000);

  it('an error with a camel-case class (fieldError) and no ARIA is found', async () => {
    await withPage(async (page) => {
      await open(page, 'rejected-camel.html');
      const [name] = await bare.fields(page);
      await bare.fill(page, { [name!.id]: 'Mara Quill' });
      const err = await bare.submit(page).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubmissionFailure);
      expect((err as SubmissionFailure).reason).toBe('form-rejected');
      expect(((err as SubmissionFailure).detail.errors as string[])[0]).toContain(
        'That name is not accepted',
      );
    });
  }, 60_000);
});
