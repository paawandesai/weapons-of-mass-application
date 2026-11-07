import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getUnresolvedCompanyByName,
  listUserCompanies,
  removeUserCompany,
  restoreUserCompany,
} from '@wma/db';
import { FakeLlm } from '@wma/llm';
import {
  CompanyListOutput,
  generateCompanyList,
  UNRESOLVED_RETRY_MS,
} from '../../src/discovery/company-list';
import type { ResolveResult } from '@wma/discovery';
import { setupEnv, type TestEnv } from '../helpers';
import { approveProfile, fixtureJson, NOW } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(() => env.cleanup());

const list = fixtureJson<CompanyListOutput>('company-list.json');
// Unique per run: the board cache is global and shared with every other test.
const tag = Math.random().toString(36).slice(2, 8);
const named = (suffix = '') =>
  ({
    companies: list.companies.map((c) => ({ ...c, name: `${c.name} ${tag}${suffix}` })),
  }) satisfies CompanyListOutput;

/** Resolves every name to a greenhouse board named after it, except names containing a marker. */
function resolver(calls: string[] = []) {
  return async (name: string, hints: string[]): Promise<ResolveResult> => {
    calls.push(name);
    void hints;
    if (name.startsWith('Copperline')) return { status: 'unresolved' };
    if (name.startsWith('Saltmarsh')) return { status: 'unavailable' };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return {
      status: 'resolved',
      partial: false,
      boards: [
        {
          ats: 'greenhouse',
          boardSlug: slug,
          region: '',
          boardUrl: `https://boards.greenhouse.io/${slug}`,
        },
      ],
    };
  };
}

describe('CompanyListOutput', () => {
  it('parses the recorded fixture with at least 20 companies and a reason each', () => {
    const out = CompanyListOutput.parse(list);
    expect(out.companies.length).toBeGreaterThanOrEqual(20);
    expect(out.companies.every((c) => c.reason.length > 0)).toBe(true);
  });
  it('rejects fewer than 20', () => {
    expect(CompanyListOutput.safeParse({ companies: list.companies.slice(0, 5) }).success).toBe(
      false,
    );
  });
});

describe('generateCompanyList', () => {
  it('first generation stores 20+ companies with reasons; unresolved are marked and a timeout is left out', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId);
    const calls: string[] = [];
    const llm = new FakeLlm([named()]);
    const r = await generateCompanyList(t.handle, t.userId, {
      llm,
      resolve: resolver(calls),
      now: () => NOW,
    });
    expect(r).toMatchObject({
      generated: true,
      suggested: 22,
      unresolved: 1,
      unavailable: 1,
      resolved: 20,
    });
    const rows = await listUserCompanies(t.handle, t.userId);
    expect(rows).toHaveLength(21); // 20 resolved + 1 unresolved (visible as dropped); the timeout is absent
    expect(rows.every((x) => x.membership.reason && x.membership.source === 'llm')).toBe(true);
    const dropped = rows.filter((x) => !x.company.ats);
    expect(dropped.map((x) => x.company.name)).toEqual([`Copperline ${tag}`]);
    expect(dropped[0]!.company.unresolvedUntil!.getTime()).toBe(
      NOW.getTime() + UNRESOLVED_RETRY_MS,
    );
    // the model saw the profile but not contact details
    expect(llm.calls[0]!.user).toContain('Ada Example');
    expect((await activity.listByUser(t.handle, t.userId)).map((e) => e.action)).toContain(
      'company_list_generated',
    );
  });

  it('regeneration respects removals and does not look up a name again within its retry window', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId);
    const out = named('-r');
    const first = await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(),
      now: () => NOW,
    });
    expect(first.generated && first.added).toBe(21);
    const rows = await listUserCompanies(t.handle, t.userId);
    const victim = rows.find((x) => x.company.name.startsWith('Northwind'))!;
    await removeUserCompany(t.handle, t.userId, victim.company.id);

    const calls: string[] = [];
    const again = await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(calls),
      now: () => NOW,
    });
    expect(again).toMatchObject({ generated: true, added: 0 });
    const active = await listUserCompanies(t.handle, t.userId);
    expect(active.some((x) => x.company.id === victim.company.id)).toBe(false);
    // only the timed-out name was looked up again; cached resolutions and the unresolved stamp were honored
    expect(calls).toEqual([`Saltmarsh ${tag}-r`]);
    // an explicit re-add restores it
    await restoreUserCompany(t.handle, t.userId, victim.company.id);
    expect(
      (await listUserCompanies(t.handle, t.userId)).some((x) => x.company.id === victim.company.id),
    ).toBe(true);
  });

  it('a removed unresolved company that resolves later is filtered out before resolution, not resurrected', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId);
    const out = named('-x');
    await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(),
      now: () => NOW,
    });
    const copperline = (await listUserCompanies(t.handle, t.userId)).find(
      (x) => !x.company.ats && x.company.name === `Copperline ${tag}-x`,
    )!;
    await removeUserCompany(t.handle, t.userId, copperline.company.id);

    // its retry window has passed and the ATS now has a board for it
    const later = new Date(NOW.getTime() + UNRESOLVED_RETRY_MS + 1000);
    const calls: string[] = [];
    const resolvesNow = async (name: string): Promise<ResolveResult> => {
      calls.push(name);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return {
        status: 'resolved',
        partial: false,
        boards: [
          {
            ats: 'greenhouse',
            boardSlug: slug,
            region: '',
            boardUrl: `https://boards.greenhouse.io/${slug}`,
          },
        ],
      };
    };
    const again = await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([out]),
      resolve: resolvesNow,
      now: () => later,
    });
    expect(again).toMatchObject({ generated: true, removed: 1 });
    expect(calls).not.toContain(`Copperline ${tag}-x`);
    const names = (await listUserCompanies(t.handle, t.userId)).map((x) => x.company.name);
    expect(names).not.toContain(`Copperline ${tag}-x`);
  });

  it('a removed resolved board is not linked again even when its name is spelled differently', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId);
    const out = named('-y');
    await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(),
      now: () => NOW,
    });
    const victim = (await listUserCompanies(t.handle, t.userId)).find((x) =>
      x.company.name.startsWith('Northwind'),
    )!;
    await removeUserCompany(t.handle, t.userId, victim.company.id);
    // the model now suggests the same company under another name that resolves to the same board
    const renamed = {
      companies: out.companies.map((c) =>
        c.name.startsWith('Northwind') ? { ...c, name: `Northwind Systems ${tag}-y` } : c,
      ),
    };
    const resolveToVictim = async (_name: string): Promise<ResolveResult> => ({
      status: 'resolved',
      partial: false,
      boards: [
        {
          ats: victim.company.ats!,
          boardSlug: victim.company.boardSlug!,
          region: '',
          boardUrl: victim.company.boardUrl!,
        },
      ],
    });
    await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([renamed]),
      resolve: resolveToVictim,
      now: () => NOW,
    });
    expect(
      (await listUserCompanies(t.handle, t.userId)).some((x) => x.company.id === victim.company.id),
    ).toBe(false);
  });

  it('an unresolved name is retried once its window has passed', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId);
    const out = named('-w');
    await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(),
      now: () => NOW,
    });
    const later = new Date(NOW.getTime() + UNRESOLVED_RETRY_MS + 1000);
    const calls: string[] = [];
    await generateCompanyList(t.handle, t.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(calls),
      now: () => later,
    });
    expect(calls).toContain(`Copperline ${tag}-w`);
    expect(
      (await getUnresolvedCompanyByName(
        t.handle,
        `Copperline ${tag}-w`,
      ))!.unresolvedUntil!.getTime(),
    ).toBe(
      later.getTime() + UNRESOLVED_RETRY_MS, // still unresolved: the window restarts
    );
  });

  it('a second user gets a cached company without any ATS lookup', async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    await approveProfile(a.handle, a.userId);
    await approveProfile(b.handle, b.userId);
    const out = named('-s');
    await generateCompanyList(a.handle, a.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(),
      now: () => NOW,
    });
    const calls: string[] = [];
    const r = await generateCompanyList(b.handle, b.userId, {
      llm: new FakeLlm([out]),
      resolve: resolver(calls),
      now: () => NOW,
    });
    expect(r).toMatchObject({ generated: true, cached: 20 });
    // user A's resolved companies were not looked up for B; the same companies are linked
    // Copperline is unresolved but inside its retry window, so it is not asked again; Saltmarsh
    // was unavailable (never stored), so B's generation must try it again. Nothing else is asked.
    expect(calls).toEqual([`Saltmarsh ${tag}-s`]);
    expect(calls).not.toContain(`Northwind Labs ${tag}-s`);
    const idsA = new Set(
      (await listUserCompanies(a.handle, a.userId))
        .filter((x) => x.company.ats)
        .map((x) => x.company.id),
    );
    const idsB = (await listUserCompanies(b.handle, b.userId))
      .filter((x) => x.company.ats)
      .map((x) => x.company.id);
    expect(idsB.length).toBeGreaterThan(0);
    expect(idsB.every((id) => idsA.has(id))).toBe(true);
  });

  it('does nothing and logs the reason when the profile is not approved', async () => {
    const t = await env.makeTenant();
    const llm = new FakeLlm([named()]);
    const r = await generateCompanyList(t.handle, t.userId, { llm, resolve: resolver() });
    expect(r).toEqual({ generated: false, reason: 'profile_not_approved' });
    expect(llm.calls).toHaveLength(0);
    expect(await listUserCompanies(t.handle, t.userId, { includeRemoved: true })).toEqual([]);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log[0]).toMatchObject({
      action: 'company_list_skipped',
      detail: { reason: 'profile_not_approved' },
    });
  });

  it('retries once on a malformed reply, then gives up and logs', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId);
    const ok = new FakeLlm([{ companies: [] }, named('-m')]);
    expect(
      (await generateCompanyList(t.handle, t.userId, { llm: ok, resolve: resolver() })).generated,
    ).toBe(true);
    const t2 = await env.makeTenant();
    await approveProfile(t2.handle, t2.userId);
    const bad = new FakeLlm([{ companies: [] }]);
    expect(
      await generateCompanyList(t2.handle, t2.userId, { llm: bad, resolve: resolver() }),
    ).toEqual({
      generated: false,
      reason: 'llm_failed',
    });
    expect(bad.calls).toHaveLength(2);
  });
});
