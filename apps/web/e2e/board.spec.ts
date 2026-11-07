import { expect, test, type Page } from '@playwright/test';

/** Needs the seeded demo tenant (`pnpm seed:demo`); skips on an empty board. */
async function appliedCardCount(page: Page): Promise<number> {
  await page.goto('/board');
  await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Applied' })).toBeVisible();
  return page.getByRole('region', { name: 'Applied' }).locator('article').count();
}

test('dragging a card to Closed persists across a reload', async ({ page }) => {
  test.skip((await appliedCardCount(page)) === 0, 'the demo board has no Applied cards');
  const applied = page.getByRole('region', { name: 'Applied' });
  const closed = page.getByRole('region', { name: 'Closed' });
  const card = applied.locator('article').first();
  const id = await card.getAttribute('data-card-id');
  await card.dragTo(closed);
  await expect(closed.locator(`article[data-card-id="${id}"]`)).toBeVisible();
  await page.reload();
  const moved = page
    .getByRole('region', { name: 'Closed' })
    .locator(`article[data-card-id="${id}"]`);
  await expect(moved).toBeVisible();
  // Put the card back so the seeded board stays as it was.
  await moved.getByRole('combobox').selectOption('applied');
  await expect(
    page.getByRole('region', { name: 'Applied' }).locator(`article[data-card-id="${id}"]`),
  ).toBeVisible();
});

test('a failed save returns the card to its column with an error toast', async ({ page }) => {
  test.skip((await appliedCardCount(page)) === 0, 'the demo board has no Applied cards');
  await page.route('**/api/applications/*/stage', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'internal', message: 'Something went wrong' }),
    }),
  );
  const applied = page.getByRole('region', { name: 'Applied' });
  const card = applied.locator('article').first();
  const id = await card.getAttribute('data-card-id');
  await card.dragTo(page.getByRole('region', { name: 'Closed' }));
  await expect(page.getByRole('alert')).toContainText(/could not be moved/i);
  await expect(applied.locator(`article[data-card-id="${id}"]`)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Closed' }).locator(`article[data-card-id="${id}"]`),
  ).toHaveCount(0);
});

test('opening a card shows resume, answers, email and activity', async ({ page }) => {
  test.skip((await appliedCardCount(page)) === 0, 'the demo board has no Applied cards');
  await page
    .getByRole('region', { name: 'Applied' })
    .locator('article')
    .first()
    .locator('button.card-title')
    .click();
  const drawer = page.getByRole('dialog', { name: 'Card detail' });
  await expect(drawer.getByRole('heading', { name: 'Resume' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Answers' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Email' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Activity' })).toBeVisible();
});

test('a card without an interview says there is no prep plan', async ({ page }) => {
  test.skip((await appliedCardCount(page)) === 0, 'the demo board has no Applied cards');
  await page
    .getByRole('region', { name: 'Applied' })
    .locator('article')
    .first()
    .locator('button.card-title')
    .click();
  await expect(page.getByRole('dialog', { name: 'Card detail' })).toContainText(/no prep plan/i);
});
