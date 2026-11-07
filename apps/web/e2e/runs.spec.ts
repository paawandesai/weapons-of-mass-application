import { expect, test } from '@playwright/test';

test.describe('run view', () => {
  test('shows the current run with its rows, or the empty state for a user without runs', async ({
    page,
    request,
  }) => {
    const res = await request.get('/api/runs/current');
    test.skip(!res.ok(), 'the API is not reachable with the demo session');
    const current = (await res.json()) as {
      run: { status: string } | null;
      candidates: unknown[];
    };

    await page.goto('/runs');
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    if (!current.run) {
      await expect(page.getByText('No run has happened yet.')).toBeVisible();
      return;
    }
    test.skip(current.candidates.length === 0, 'the seeded run has no candidates');
    const rows = page.getByRole('list', { name: 'Candidates' }).getByRole('listitem');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('Postings considered')).toBeVisible();
  });

  test('rows appear without a reload while a run is in progress', async ({ page, request }) => {
    const res = await request.get('/api/runs/current');
    test.skip(!res.ok(), 'the API is not reachable with the demo session');
    const current = (await res.json()) as { run: { status: string } | null };
    test.skip(current.run?.status !== 'running', 'no seeded in-progress run');
    await page.goto('/runs');
    await expect(page.getByText('Running', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Candidates' })).toBeVisible({ timeout: 15_000 });
  });
});
