import type { Locator, Page } from 'playwright';
import { SubmissionFailure } from '../failure';
import type { CaptchaHandle, FieldDescriptor, FieldValues, FormNotice } from '../types';
import { classifyField } from './classify';
import { OPTIONS_SCRIPT, PROBE_SCRIPT, SCAN_SCRIPT } from './scan-script';

/**
 * The generic page layer (docs/design/wave5-generic-submitter.md, Part A). It reads the form the
 * way a person does: from labels, roles and groups, not from vendor selectors. The browser-side
 * scan is in scan-script.ts; everything here runs in Node and acts on the controls the scan
 * stamped with `data-wma-c`.
 */

export type Kind =
  | 'text'
  | 'number'
  | 'email'
  | 'tel'
  | 'url'
  | 'textarea'
  | 'select'
  | 'combobox'
  | 'listbox'
  | 'yesno'
  | 'radio'
  | 'checkbox-group'
  | 'checkbox'
  | 'date'
  | 'file'
  | 'unknown';

export interface Member {
  ref: number;
  label: string;
  value: string;
  dataOption: string;
}

export interface Question {
  id: string;
  label: string;
  kind: Kind;
  required: boolean;
  maxLength: number | null;
  options?: string[];
  members: Member[];
  typeRef: number | null;
  /** Section heading, class names, control name and id: the vendor-structure signal. */
  context: string;
  step: number | null;
  placeholder: string;
  inputType: string;
  itl: boolean;
  current: string | boolean | string[];
  /** A native select's selected value (the label is in `current`). */
  currentValue?: string;
  isResume: boolean;
  note?: 'unknown-control';
  /** Set by option reading: more than LARGE_LIST options, so `options` is left out. */
  largeList?: boolean;
  /** Rule 22: the text that explains the question (help text, instructions), bounded to 1,000 chars. */
  description?: string;
}

export interface PageScan {
  questions: Question[];
  submit: { text: string; disabled: boolean; step: number | null } | null;
  resumeRef: number | null;
  steps: { count: number; active: number | null };
  controls: number;
}

export interface Probe {
  controlsLeft: boolean;
  rootGone: boolean;
  thanks: boolean;
  errors: string[];
  frame: boolean;
  notice: { max: number; days: number } | null;
  /** Only when asked for (the pre-submit baseline). */
  bodyText?: string;
}

export const THANKS_SOURCE =
  "thank you for (applying|your application)|application (has been |was )?(submitted|received)|we('ve| have) received your application";

export const LARGE_LIST = 60;
const ACTION_TIMEOUT_MS = 5_000;
const OPTIONS_WAIT_MS = 2_000;
const OPTIONS_EARLY_MS = 400;
const TYPED_OPTIONS_WAIT_MS = 3_000;
const NETWORK_IDLE_MS = 8_000;
const STABLE_MS = 500;
const STABLE_MAX_MS = 10_000;
const RESULTS_WAIT_MS = 1_500;
const MAX_STEPS = 12;
const STEP_WAIT_MS = 3_000;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const low = (s: string) => norm(s).toLowerCase();
const digitsOf = (s: string) => s.replace(/\D/g, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ref = (n: number) => `[data-wma-c="${n}"]`;
/** Runs `fn` (function source) in the page with the stamped control as its argument. */
async function onControl<T>(page: Page, n: number, fn: string, fallback: T): Promise<T> {
  try {
    return (await page.evaluate(`(${fn})(document.querySelector('${ref(n)}'))`)) as T;
  } catch {
    return fallback;
  }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True for the errors a navigating page throws while an evaluate is in flight. */
function isNavigationError(e: unknown): boolean {
  return /Execution context was destroyed|navigation|Target (page, context or browser )?has been closed/i.test(
    e instanceof Error ? e.message : String(e),
  );
}

async function evaluateStable<T>(page: Page, script: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await page.evaluate(script)) as T;
    } catch (e) {
      if (attempt < 3 && isNavigationError(e)) {
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        continue;
      }
      throw e;
    }
  }
}

/** Reads the page and stamps its controls (rules 1-6). */
export function scanPage(page: Page): Promise<PageScan> {
  return evaluateStable<PageScan>(
    page,
    `(${SCAN_SCRIPT})(${JSON.stringify({ largeList: LARGE_LIST })})`,
  );
}

/** The visible page text just before each submit click, per page (design rule 12, P1 evidence). */
const baselines = new WeakMap<Page, string>();

export function probePage(page: Page, wantText = false): Promise<Probe> {
  return evaluateStable<Probe>(
    page,
    `(${PROBE_SCRIPT})(${JSON.stringify({ thanks: THANKS_SOURCE, before: baselines.get(page), wantText })})`,
  );
}

/**
 * Records the page text before a submit click. A thank-you message counts as confirmation only
 * when it appeared after this point, never when it was already on the page (boilerplate).
 */
export async function recordBaseline(page: Page): Promise<void> {
  const probe = await probePage(page, true).catch(() => null);
  if (probe?.bodyText !== undefined) baselines.set(page, probe.bodyText);
}

// ---- stamps that survive (rule 19) ---------------------------------------------------------

const refsOf = (q: Question): number[] => [
  ...q.members.map((m) => m.ref),
  ...(q.typeRef !== null ? [q.typeRef] : []),
];

const refsOfScan = (scan: PageScan): number[] => [
  ...scan.questions.flatMap(refsOf),
  ...(scan.resumeRef !== null ? [scan.resumeRef] : []),
];

/** True when every stamped element is still attached: a framework may have replaced them. */
export async function stampsAlive(page: Page, refs: number[]): Promise<boolean> {
  try {
    return (await page.evaluate(
      `(${JSON.stringify(refs)}).every((n) => !!document.querySelector('[data-wma-c="' + n + '"]')) && !!document.querySelector('[data-wma-root]')`,
    )) as boolean;
  } catch {
    return false;
  }
}

/** Runs `act` on `scan`, or on a fresh scan when a stamped element has gone missing (rule 19). */
export async function withFreshScan<T>(
  page: Page,
  scan: PageScan,
  act: (scan: PageScan) => Promise<T>,
): Promise<T> {
  const live = (await stampsAlive(page, refsOfScan(scan))) ? scan : await scanPage(page);
  return act(live);
}

/**
 * Waits for a hydrating page to settle (rule 19): network idle (bounded), then rescans until one
 * scan's stamped elements all survive a pause, so the next action lands on live elements.
 */
export async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => undefined);
  const deadline = Date.now() + STABLE_MAX_MS;
  for (;;) {
    const scan = await scanPage(page).catch(() => null);
    if (!scan || scan.questions.length === 0) return; // an account page or a confirmation
    await sleep(STABLE_MS);
    if (await stampsAlive(page, refsOfScan(scan))) return;
    if (Date.now() >= deadline) return;
  }
}

// ---- descriptors -------------------------------------------------------------------------

export function descriptorType(q: Question): FieldDescriptor['type'] {
  switch (q.kind) {
    case 'textarea':
      return 'textarea';
    case 'select':
    case 'listbox':
      return 'select';
    case 'combobox':
      return q.options?.length || q.largeList ? 'select' : 'text';
    case 'yesno':
    case 'radio':
      return 'radio';
    case 'checkbox-group':
    case 'checkbox':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    case 'file':
      return 'file';
    default:
      return 'text';
  }
}

export function describe(q: Question): FieldDescriptor {
  const type = descriptorType(q);
  const d: FieldDescriptor = {
    id: q.id,
    label: q.label,
    type,
    required: q.required,
    maxLength: q.maxLength,
    classification: classifyField({ label: q.label, type, hint: q.context }),
  };
  if (q.options?.length && !q.largeList) d.options = q.options;
  if (q.description) d.description = q.description;
  if (q.largeList) d.hint = 'large-list';
  else if (q.note) d.hint = q.note;
  return d;
}

// ---- comboboxes ----------------------------------------------------------------------------

type OptionRow = { i: number; text: string };

async function markExistingOptions(page: Page): Promise<void> {
  await page.evaluate(`(${OPTIONS_SCRIPT})(${JSON.stringify({ mark: true })})`);
}

async function collectOptions(
  page: Page,
  q: Question,
  totalMs: number,
  earlyMs: number,
): Promise<OptionRow[]> {
  const refs = [q.typeRef, q.members[0]!.ref].filter((n): n is number => n !== null);
  const args = JSON.stringify({ refs, prefix: '' });
  const started = Date.now();
  for (;;) {
    let r: { options: OptionRow[]; expanded: boolean };
    try {
      r = (await page.evaluate(`(${OPTIONS_SCRIPT})(${args})`)) as typeof r;
    } catch {
      return [];
    }
    if (r.options.length > 0) return r.options;
    const waited = Date.now() - started;
    if (waited > earlyMs && !r.expanded) return [];
    if (waited >= totalMs) return [];
    await sleep(100);
  }
}

/**
 * After typing into a combobox the previous options often stay mounted until the filtered result
 * arrives. Waits until an option containing the text is there, or the option set has changed and
 * settled, or the time is up; never mistakes the old rows for the answer.
 */
async function waitForResults(
  page: Page,
  q: Question,
  text: string,
  before: string[],
  totalMs: number,
): Promise<OptionRow[]> {
  const want = low(text);
  const started = Date.now();
  let lastKey = before.join('\n');
  let changed = false;
  let stableSince = Date.now();
  for (;;) {
    const rows = await collectOptions(page, q, 0, 0);
    if (rows.some((r) => low(r.text).includes(want))) return rows;
    const key = rows.map((r) => r.text).join('\n');
    if (key !== lastKey) {
      lastKey = key;
      changed = true;
      stableSince = Date.now();
    } else if (changed && Date.now() - stableSince >= 300) {
      return rows;
    }
    if (Date.now() - started >= totalMs) return rows;
    await sleep(100);
  }
}

/**
 * Opens a combobox and reads its options once (rule 7). Null when the control cannot be opened.
 * The menu may render in a portal outside the form; the collector finds the active control's own.
 */
async function readComboOptions(page: Page, q: Question): Promise<string[] | null> {
  const control = page.locator(ref(q.typeRef ?? q.members[0]!.ref));
  await markExistingOptions(page);
  try {
    await control.click({ timeout: 2_000 });
  } catch {
    return null;
  }
  const rows = await collectOptions(page, q, OPTIONS_WAIT_MS, OPTIONS_EARLY_MS);
  await page.keyboard.press('Escape').catch(() => undefined);
  return [...new Set(rows.map((r) => r.text))];
}

/**
 * Reads the options of every combobox on the scan (bounded, see LARGE_LIST). Opening a menu can
 * make the page re-render, so a question whose stamps went missing is looked up again on a fresh
 * scan (rule 19). Returns the scan the options were attached to.
 */
export async function enrichOptions(page: Page, scan: PageScan): Promise<PageScan> {
  let cur = scan;
  const read = new Map<string, { options?: string[]; largeList?: boolean }>();
  for (const id of scan.questions
    .filter((q) => q.kind === 'combobox' && !q.options)
    .map((q) => q.id)) {
    let q = cur.questions.find((x) => x.id === id);
    if (q && !(await stampsAlive(page, refsOf(q)))) {
      cur = await scanPage(page);
      q = cur.questions.find((x) => x.id === id);
    }
    if (!q) continue;
    const options = await readComboOptions(page, q);
    if (!options || options.length === 0) continue;
    read.set(id, options.length > LARGE_LIST ? { largeList: true } : { options });
  }
  for (const q of cur.questions) {
    const r = read.get(q.id);
    if (!r || q.kind !== 'combobox') continue;
    if (r.largeList) q.largeList = true;
    else q.options = r.options;
  }
  if (cur.questions.some((q) => q.kind === 'combobox')) {
    // Opening menus must not leave the form changed; stamps are refreshed by the next scan.
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  return cur;
}

// ---- filling -----------------------------------------------------------------------------

export interface Intent {
  text: string;
  list: string[];
  bool: boolean;
  /** The text as typed into a date or phone widget. */
  typed?: string;
  /** The option actually selected, when it is not the intended text itself (starts/contains match). */
  chosen?: string;
}

const YES = /^(yes|true|y|1|on)$/i;

function wantBool(v: string | boolean | string[]): boolean {
  if (typeof v === 'boolean') return v;
  const t = Array.isArray(v) ? (v[0] ?? '') : v;
  return YES.test(t.trim());
}

function intentOf(q: Question, v: string | boolean | string[]): Intent {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [v ? 'Yes' : 'No'];
  const text = Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v;
  const intent: Intent = { text, list, bool: wantBool(v) };
  if (q.kind === 'date') intent.typed = formatDate(q, text);
  return intent;
}

/** Placeholder formats such as MM/DD/YYYY, DD.MM.YYYY, YYYY-MM-DD (rule 7, date). */
function dateFormatOf(placeholder: string): string {
  const p = placeholder.trim();
  return /^[mdy]{1,4}([/.-])[mdy]{1,4}\1[mdy]{2,4}$/i.test(p) ? p.toUpperCase() : 'MM/DD/YYYY';
}

function parseDate(text: string): { y: number; m: number; d: number } | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (us) return { y: Number(us[3]), m: Number(us[1]), d: Number(us[2]) };
  const t = Date.parse(`${text} UTC`);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  return null;
}

function formatDate(q: Question, text: string): string {
  const parts = parseDate(text);
  if (!parts) return text;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  if (q.inputType === 'date') return `${pad(parts.y, 4)}-${pad(parts.m)}-${pad(parts.d)}`;
  return dateFormatOf(q.placeholder)
    .replace(/YYYY/, pad(parts.y, 4))
    .replace(/YY/, pad(parts.y % 100))
    .replace(/MM/, pad(parts.m))
    .replace(/DD/, pad(parts.d));
}

function pickMember(q: Question, wanted: string): Member | undefined {
  const w = low(wanted);
  return (
    q.members.find((m) => low(m.label) === w) ??
    q.members.find((m) => m.value !== '' && low(m.value) === w) ??
    q.members.find((m) => m.dataOption !== '' && m.dataOption === w)
  );
}

/** On/off state of an input or an ARIA toggle (a button has no `checked`, only aria-pressed). */
const PRESSED_SRC =
  "(e) => e.tagName === 'INPUT' ? !!e.checked : e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-pressed') === 'true'";

async function setChecked(page: Page, n: number, want: boolean): Promise<void> {
  const loc = page.locator(ref(n));
  const isButton = await onControl<boolean>(
    page,
    n,
    "(e) => e.tagName === 'BUTTON' || (e.tagName !== 'INPUT' && !/^(checkbox|radio|switch)$/.test(e.getAttribute('role') || ''))",
    false,
  );
  if (isButton) {
    if ((await onControl<boolean>(page, n, PRESSED_SRC, want)) !== want) {
      await loc.click({ timeout: ACTION_TIMEOUT_MS });
    }
    return;
  }
  try {
    await loc.setChecked(want, { timeout: 3_000 });
  } catch {
    try {
      await loc.setChecked(want, { force: true, timeout: 2_000 });
    } catch {
      // Custom controls: a click toggles. Only click when the state differs.
      const now = await onControl<boolean>(page, n, PRESSED_SRC, want);
      if (now !== want) await loc.click({ force: true, timeout: 2_000 });
    }
  }
}

async function isPressed(page: Page, n: number): Promise<boolean> {
  return onControl<boolean>(page, n, PRESSED_SRC, false);
}

async function chooseOne(page: Page, q: Question, wanted: string): Promise<void> {
  const member = pickMember(q, wanted);
  if (!member) throw new Error(`no option "${wanted}"`);
  const isInput = await onControl<boolean>(page, member.ref, "(e) => e.tagName === 'INPUT'", false);
  if (isInput) {
    await setChecked(page, member.ref, true);
    return;
  }
  if (!(await isPressed(page, member.ref))) {
    await page.locator(ref(member.ref)).click({ timeout: ACTION_TIMEOUT_MS });
  }
}

/** Clicks the first option that matches by the first mode that has a hit; returns its text. */
async function pickOption(
  page: Page,
  rows: OptionRow[],
  value: string,
  modes: Array<'equals' | 'starts' | 'contains'>,
): Promise<string | null> {
  const v = low(value);
  for (const mode of modes) {
    const hit = rows.find((r) => {
      const t = low(r.text);
      return mode === 'equals' ? t === v : mode === 'starts' ? t.startsWith(v) : t.includes(v);
    });
    if (hit) {
      await page.locator(`[data-wma-o="${hit.i}"]`).first().click({ timeout: ACTION_TIMEOUT_MS });
      return hit.text;
    }
  }
  return null;
}

async function fillCombobox(page: Page, q: Question, intent: Intent): Promise<void> {
  const text = intent.text;
  const control = page.locator(ref(q.typeRef ?? q.members[0]!.ref));
  await markExistingOptions(page);
  await control.click({ timeout: ACTION_TIMEOUT_MS });
  let rows = await collectOptions(page, q, OPTIONS_WAIT_MS, OPTIONS_EARLY_MS);
  if (rows.length > 0) {
    const first = await pickOption(page, rows, text, ['equals', 'starts']);
    if (first !== null) {
      intent.chosen = first;
      return;
    }
    // The list may be long or filtered by typing: narrow it, then accept a containing match.
    const before = rows.map((r) => r.text);
    await control.press('Control+a').catch(() => undefined);
    await control.pressSequentially(text, { delay: 15 }).catch(() => undefined);
    rows = await waitForResults(page, q, text, before, RESULTS_WAIT_MS);
    const second = await pickOption(page, rows, text, ['equals', 'starts', 'contains']);
    if (second !== null) {
      intent.chosen = second;
      return;
    }
    // Nothing matched: leave the control as it was, without the text typed to narrow the list.
    await control.fill('').catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
    return;
  }
  // An autocomplete with no preloaded options: type, then take the first option containing it.
  await control.fill(text, { timeout: ACTION_TIMEOUT_MS }).catch(async () => {
    await control.pressSequentially(text, { delay: 15 });
  });
  rows = await waitForResults(page, q, text, [], TYPED_OPTIONS_WAIT_MS);
  const picked = await pickOption(page, rows, text, ['equals', 'starts', 'contains']);
  if (picked !== null) intent.chosen = picked;
  // None within 3 s: the typed text stays. A free-text autocomplete keeps it; a select-style
  // combobox has no committed selection then, which the verification reports (rule 9).
}

async function fillListbox(page: Page, q: Question, text: string): Promise<void> {
  const control = page.locator(ref(q.members[0]!.ref));
  const option = control
    .locator('[role=option]')
    .filter({ hasText: new RegExp(`^\\s*${escapeRe(text)}\\s*$`, 'i') })
    .first();
  await option.click({ timeout: ACTION_TIMEOUT_MS });
}

/**
 * Rule 7 and 20: the option whose label equals the text, else whose value does, else whose label
 * equals it ignoring case, else (a large list) whose label contains it. Options are read from the
 * page once, so a miss costs no timeout.
 */
async function nativeSelect(page: Page, q: Question, intent: Intent): Promise<void> {
  const text = intent.text;
  const loc = page.locator(ref(q.members[0]!.ref));
  const options = await onControl<Array<{ i: number; t: string; v: string }>>(
    page,
    q.members[0]!.ref,
    `(e) => Array.prototype.map.call(e.options, (o, i) => ({ i, t: (o.textContent || '').replace(/\\s+/g, ' ').trim(), v: o.value })).filter((o) => o.v !== '')`,
    [],
  );
  const w = low(text);
  const hit =
    options.find((o) => o.t === norm(text)) ??
    options.find((o) => o.v === text) ??
    options.find((o) => low(o.t) === w) ??
    options.find((o) => low(o.v) === w) ??
    (q.largeList ? options.find((o) => low(o.t).includes(w)) : undefined);
  if (!hit) throw new Error(`no option "${text}"`);
  await loc.selectOption({ index: hit.i }, { timeout: 3_000 });
  intent.chosen = hit.t;
}

/** The dial code of an international phone widget's selected country, digits only. */
async function widgetDialCode(page: Page, q: Question): Promise<string> {
  return onControl<string>(
    page,
    q.members[0]!.ref,
    `(el) => {
      const w = el.closest('[class*=iti]');
      if (!w) return '';
      const sel = w.querySelector('.iti__selected-dial-code');
      const fromSel = sel ? sel.textContent || '' : '';
      const btn = w.querySelector('.iti__selected-country');
      const fromBtn = btn ? btn.getAttribute('title') || '' : '';
      const m = /\\+?(\\d{1,4})/.exec(fromSel) || /\\+(\\d{1,4})/.exec(fromBtn);
      return m ? m[1] : '';
    }`,
    '',
  );
}

async function setWidgetCountry(page: Page, q: Question, country: string): Promise<void> {
  const loc = page.locator(ref(q.members[0]!.ref));
  const widget = loc.locator('xpath=ancestor::*[contains(@class,"iti")][1]');
  const button = widget.locator('.iti__selected-country').first();
  if ((await button.count()) === 0) return;
  await button.click({ timeout: 3_000 });
  const item = widget
    .locator('[role=option], li')
    .filter({ hasText: new RegExp(escapeRe(country), 'i') })
    .first();
  if ((await item.count()) > 0) await item.click({ timeout: 3_000 });
  else await page.keyboard.press('Escape');
}

async function fillTel(
  page: Page,
  q: Question,
  intent: Intent,
  country: string | null,
): Promise<void> {
  const text = intent.text;
  const loc = page.locator(ref(q.members[0]!.ref));
  let value = text;
  if (q.itl) {
    if (country) await setWidgetCountry(page, q, country).catch(() => undefined);
    const dial = await widgetDialCode(page, q);
    const digits = digitsOf(text);
    // The widget shows the national number once its country is set.
    if (dial && text.trim().startsWith('+') && digits.startsWith(dial))
      value = digits.slice(dial.length);
  }
  await loc.fill(value, { timeout: ACTION_TIMEOUT_MS });
  intent.typed = value;
}

async function fillQuestion(
  page: Page,
  q: Question,
  v: string | boolean | string[],
  intent: Intent,
  countryOf: () => string | null,
): Promise<void> {
  const first = page.locator(ref(q.members[0]!.ref));
  switch (q.kind) {
    case 'text':
    case 'number':
    case 'email':
    case 'url':
    case 'textarea':
    case 'unknown':
      await first.fill(intent.text, { timeout: ACTION_TIMEOUT_MS });
      return;
    case 'tel':
      await fillTel(page, q, intent, countryOf());
      return;
    case 'date':
      await first.fill(intent.typed ?? intent.text, { timeout: ACTION_TIMEOUT_MS });
      await page.keyboard.press('Escape').catch(() => undefined);
      return;
    case 'select':
      await nativeSelect(page, q, intent);
      return;
    case 'combobox':
      await fillCombobox(page, q, intent);
      return;
    case 'listbox':
      await fillListbox(page, q, intent.text);
      return;
    case 'yesno':
    case 'radio':
      await chooseOne(
        page,
        q,
        typeof v === 'boolean' ? (v ? 'Yes' : 'No') : (intent.list[0] ?? ''),
      );
      return;
    case 'checkbox-group': {
      // Nothing is touched when an intended option does not exist: unchecking everything for a
      // renamed option would submit the group empty.
      const wanted = resolveGroup(q, intent.list);
      if (!wanted) throw new Error('an intended option is not among the group options');
      for (const m of q.members) await setChecked(page, m.ref, wanted.includes(m));
      return;
    }
    case 'checkbox':
      await setChecked(page, q.members[0]!.ref, intent.bool);
      return;
    case 'file':
      return; // only the resume input is ever filled, by attachResume
  }
}

// ---- verification (rule 9) -------------------------------------------------------------------

function sameSet(a: string[], b: string[]): boolean {
  const x = new Set(a.map(low));
  const y = new Set(b.map(low));
  return x.size === y.size && [...x].every((i) => y.has(i));
}

/** The members an intended list of checkbox-group options resolves to; null when any is missing. */
function resolveGroup(q: Question, list: string[]): Member[] | null {
  const out: Member[] = [];
  for (const item of list) {
    const w = low(item);
    const m = q.members.find((x) => low(x.label) === w || (x.value !== '' && low(x.value) === w));
    if (!m) return null;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * True when the question's current value is the intended one. Values are compared whole: a
 * shorter or longer value is not the intended one (a truncated phone number or a country that
 * is a prefix of another does not verify).
 */
export function stuck(q: Question, intent: Intent): boolean {
  const cur = q.current;
  const curText = typeof cur === 'string' ? cur : Array.isArray(cur) ? cur.join(', ') : '';
  switch (q.kind) {
    case 'checkbox':
      return cur === intent.bool;
    case 'checkbox-group': {
      const chosen = Array.isArray(cur) ? cur : [];
      const want = resolveGroup(q, intent.list);
      return (
        want !== null &&
        sameSet(
          chosen,
          want.map((m) => m.label),
        )
      );
    }
    case 'radio':
    case 'yesno': {
      const member = pickMember(q, intent.list[0] ?? '');
      return !!member && low(member.label) === low(curText);
    }
    case 'select': {
      // By label or by value: `nativeSelect` accepts either.
      const wanted = low(intent.chosen ?? intent.text);
      const label = low(curText);
      const value = low(q.currentValue ?? '');
      return label !== '' && (label === wanted || (value !== '' && value === wanted));
    }
    case 'listbox':
      return low(curText) === low(intent.text);
    case 'combobox': {
      const t = low(curText);
      const w = low(intent.chosen ?? intent.text);
      // A clicked option may be shown with decoration around it; a typed value must be exact.
      return t !== '' && (t === w || (intent.chosen !== undefined && t.includes(w)));
    }
    case 'tel': {
      const a = digitsOf(curText);
      return a !== '' && a === digitsOf(intent.typed ?? intent.text);
    }
    case 'date':
      return norm(curText) === norm(intent.typed ?? intent.text);
    case 'file':
      return true;
    default:
      return norm(curText) === norm(intent.text);
  }
}

/** True when the question has no answer at all (used to audit required questions). */
function isEmpty(q: Question): boolean {
  const cur = q.current;
  if (q.kind === 'checkbox') return cur !== true;
  if (Array.isArray(cur)) return cur.length === 0;
  return typeof cur !== 'string' || norm(cur) === '';
}

// ---- steps -------------------------------------------------------------------------------

async function activeStep(page: Page): Promise<number | null> {
  return evaluateStable<number | null>(
    page,
    `(() => {
      const root = document.querySelector('[data-wma-root]');
      if (!root) return null;
      const p = Array.prototype.slice.call(root.querySelectorAll('[data-step]')).filter(
        (x) => getComputedStyle(x).display !== 'none' && !x.hidden,
      )[0];
      return p ? Number(p.getAttribute('data-step')) : null;
    })()`,
  );
}

/** Walks a stepped form (sections with `data-step`) with its Next/Back buttons. */
export async function goToStep(page: Page, target: number): Promise<PageScan> {
  for (let i = 0; i < MAX_STEPS; i++) {
    const scan = await scanPage(page);
    const here = scan.steps.active;
    if (scan.steps.count === 0 || here === null || here === target) return scan;
    const dir = here < target ? 'next' : 'back';
    const button = page.locator(`[data-wma-nav="${dir}"]`).first();
    if ((await button.count()) === 0) throw new Error(`no ${dir} button on step ${here}`);
    await button.click({ timeout: ACTION_TIMEOUT_MS });
    const started = Date.now();
    while ((await activeStep(page)) === here) {
      if (Date.now() - started > STEP_WAIT_MS) {
        throw new Error(`step ${here} did not advance (a required field is empty)`);
      }
      await sleep(100);
    }
  }
  throw new Error(`could not reach step ${target}`);
}

// ---- the whole fill ----------------------------------------------------------------------

export interface FillFailure {
  id: string;
  label: string;
}

/** An anonymous question's id is a structural path (`q:<label>:<tag>`), not a name. */
const isAnonymous = (id: string) => id.startsWith('q:');

/**
 * The same question on a newer scan. Named ids may be regenerated by a framework, so the label is
 * a fallback for them; an anonymous id is never matched by anything else, and a label that
 * differs under the same anonymous id means another control, which is not touched.
 */
function findQuestion(scan: PageScan, q: Question): Question | undefined {
  const byId = scan.questions.find((x) => x.id === q.id);
  if (byId) return isAnonymous(q.id) && byId.label !== q.label ? undefined : byId;
  if (isAnonymous(q.id)) return undefined;
  return scan.questions.find((x) => !isAnonymous(x.id) && x.label === q.label);
}

/**
 * Fills the questions that have values, then rescans and compares (rule 9). Self-identification
 * and file questions are never touched. Returns the required questions whose value did not stick,
 * and every required question still empty on the final scan (an answer can reveal a new one).
 */
export async function fillPage(page: Page, values: FieldValues): Promise<FillFailure[]> {
  const initial = await scanPage(page);
  const isSelfId = (q: Question): boolean =>
    classifyField({ label: q.label, type: descriptorType(q), hint: q.context }) ===
    'self-identification';
  const wanted = (q: Question): boolean => {
    if (values[q.id] === undefined || q.kind === 'file') return false;
    return !isSelfId(q);
  };
  const plan = initial.questions.filter(wanted);
  const intents = new Map<string, Intent>();
  for (const q of plan) intents.set(q.id, intentOf(q, values[q.id]!));

  // A phone widget's country comes from a sibling "Country" question when one has a value.
  const countryOf = (): string | null => {
    for (const q of initial.questions) {
      if (/^(phone )?country( code)?$/i.test(q.label)) {
        const v = values[q.id];
        if (typeof v === 'string' && v.trim() !== '') return v;
      }
    }
    return null;
  };

  const attempt = async (scan: PageScan, planned: Question[]): Promise<void> => {
    let current = await withFreshScan(page, scan, async (live) => live);
    const steps = [
      ...new Set(
        planned
          .map((p) => findQuestion(current, p)?.step)
          .filter((x): x is number | null => x !== undefined),
      ),
    ];
    steps.sort((a, b) => (a ?? -1) - (b ?? -1));
    for (const step of steps) {
      if (step !== null) current = await goToStep(page, step);
      for (const p of planned) {
        let q = findQuestion(current, p);
        if (!q || q.step !== step) continue;
        // A framework may have replaced the elements since the scan: look again before acting.
        if (!(await stampsAlive(page, refsOf(q)))) {
          current = await scanPage(page);
          q = findQuestion(current, p);
          if (!q) continue;
        }
        try {
          await fillQuestion(page, q, values[p.id]!, intents.get(p.id)!, countryOf);
        } catch {
          // Verification below decides whether this matters (rule 9).
        }
      }
    }
  };

  await attempt(initial, plan);

  const check = (scan: PageScan, qs: Question[]): Question[] =>
    qs.filter((q) => {
      const now = findQuestion(scan, q);
      return !now || !stuck(now, intents.get(q.id)!);
    });
  let after = await scanPage(page);
  let failed = check(after, plan);
  if (failed.length > 0) {
    // One retry for what did not stick (a re-render can drop a first attempt).
    await attempt(after, failed);
    after = await scanPage(page);
    failed = check(after, failed);
  }
  const out = new Map<string, FillFailure>();
  for (const q of failed) if (q.required) out.set(q.id, { id: q.id, label: q.label });
  // Audit the final scan: a required question that is empty, whatever the plan said. Self-
  // identification is never filled and the resume goes through attachResume.
  for (const q of after.questions) {
    if (!q.required || q.kind === 'file' || isSelfId(q) || !isEmpty(q)) continue;
    if (!out.has(q.id)) out.set(q.id, { id: q.id, label: q.label });
  }
  return [...out.values()];
}

// ---- resume, submit, captcha -------------------------------------------------------------

export async function attachResumeGeneric(
  page: Page,
  override: string | undefined,
  pdf: { filename: string; bytes: Buffer },
): Promise<void> {
  let input: Locator | null = null;
  if (override) {
    const l = page.locator(override).first();
    if ((await l.count()) > 0) input = l;
  }
  if (!input) {
    const scan = await scanPage(page);
    if (scan.resumeRef !== null) input = page.locator(ref(scan.resumeRef));
  }
  if (!input) {
    // A drop-zone with no input cannot be filled; a form with no resume field proceeds.
    const dropZone = await page
      .evaluate(
        `(() => {
          const root = document.querySelector('[data-wma-root]') || document.body;
          return Array.prototype.slice.call(root.querySelectorAll('[class*=drop i],[class*=upload i],[data-testid*=drop i]')).some(
            (e) => e.getClientRects().length > 0 && /resume|cv/i.test(e.textContent || ''),
          );
        })()`,
      )
      .catch(() => false);
    if (dropZone) {
      throw new SubmissionFailure('unmapped-field', {
        field: 'resume',
        fields: [{ id: 'resume', label: 'Resume' }],
      });
    }
    return;
  }
  await input.setInputFiles({ name: pdf.filename, mimeType: 'application/pdf', buffer: pdf.bytes });
}

/** Rule 13: iframe challenges and site-key widgets with a visible box. */
export async function findFrameCaptcha(page: Page): Promise<CaptchaHandle | null> {
  const probe = await probePage(page).catch(() => null);
  if (!probe?.frame) return null;
  return {
    challenge: 'frame',
    screenshot: () => page.screenshot({ fullPage: true, type: 'png' }),
    // The challenge lives in a cross-origin iframe: there is no text field to type into.
    enter: async () => undefined,
    cleared: async () => !(await probePage(page).catch(() => ({ frame: true }))).frame,
  };
}

export async function readNotices(page: Page): Promise<FormNotice[]> {
  const probe = await probePage(page).catch(() => null);
  return probe?.notice ? [{ kind: 'application-limit', ...probe.notice }] : [];
}

export const SUBMIT_UNMAPPED = {
  field: 'submit',
  fields: [{ id: 'submit', label: 'Submit' }],
} as const;
