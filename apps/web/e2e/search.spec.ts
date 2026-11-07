import { expect, test } from '@playwright/test';

test('typing part of a company name opens and highlights its card', async ({ page }) => {
  await page.goto('/board');
  await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible();
  const first = page.locator('article[data-card-id]').first();
  test.skip((await first.count()) === 0, 'the demo board is empty');
  const company = (await first.locator('button.card-title').innerText()).trim();
  const id = await first.getAttribute('data-card-id');
  const partial = company.slice(1, 4).toLowerCase();

  await page.getByRole('searchbox', { name: 'Find a company' }).fill(partial);
  const results = page.getByRole('list', { name: 'Search results' });
  await expect(results).toBeVisible();
  await results
    .getByRole('button', { name: new RegExp(company) })
    .first()
    .click();

  await expect(page.getByRole('dialog', { name: 'Card detail' })).toBeVisible();
  await expect(
    page.locator(`article[data-card-id="${id}"][data-highlighted="true"]`),
  ).toBeVisible();
});

test('a name that matches nothing says so and leaves the board in place', async ({ page }) => {
  await page.goto('/board');
  await page.getByRole('searchbox', { name: 'Find a company' }).fill('zzzqqq');
  await expect(page.getByText(/nothing matched/i)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Applied' })).toBeVisible();
});
