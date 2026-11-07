import { expect, test } from '@playwright/test';
import { findInterview } from './helpers';

test.describe('prep plan', () => {
  test('opens from the card and shows the four sections', async ({ page, request }) => {
    const found = await findInterview(request, (i) => i.prep_plan_status === 'ready');
    test.skip(!found, 'no seeded interview with a ready prep plan');
    await page.goto(`/applications/${found!.applicationId}`);
    await page.getByRole('link', { name: 'Open the prep plan' }).first().click();
    await expect(page).toHaveURL(/\/interviews\/.+\/prep$/);
    for (const heading of [
      'Likely questions',
      'Topics to review',
      'Company research',
      'Interviewer',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  test('a card whose interview has no plan offers to generate one', async ({ page, request }) => {
    const found = await findInterview(request, (i) => i.prep_plan_status === null);
    test.skip(!found, 'every seeded interview already has a plan');
    await page.goto(`/applications/${found!.applicationId}`);
    await expect(page.getByRole('button', { name: 'Generate prep plan' })).toBeVisible();
  });
});
