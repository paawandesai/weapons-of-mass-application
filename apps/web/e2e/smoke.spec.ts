import { expect, test } from '@playwright/test';

test('the demo user lands on the board', async ({ page }) => {
  await page.goto('/board');
  await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible();
});
