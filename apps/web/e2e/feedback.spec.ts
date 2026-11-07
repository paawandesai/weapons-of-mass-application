import { expect, test } from '@playwright/test';
import { findInterview } from './helpers';

test.describe('interview feedback', () => {
  test('submit from the reminder link, then see it on the card', async ({ page, request }) => {
    const found = await findInterview(request, (i) => i.feedback === null);
    test.skip(!found, 'no seeded interview without feedback');
    const { applicationId, interview } = found!;

    await page.goto(`/interviews/${interview.id}/feedback`);
    const form = page.getByRole('form', { name: 'Interview feedback' });
    await form.getByLabel('Your notes').fill('Good conversation about fleet scheduling.');
    await form.getByLabel(/Overall rating/).selectOption('4');
    await form.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(form.getByText('Saved.')).toBeVisible();

    await page.goto(`/applications/${applicationId}`);
    const onCard = page.getByRole('form', { name: 'Interview feedback' });
    await expect(onCard.getByLabel('Your notes')).toHaveValue(
      'Good conversation about fleet scheduling.',
    );
  });

  test('an empty submission is refused with a message', async ({ page, request }) => {
    const found = await findInterview(request, (i) => i.feedback === null);
    test.skip(!found, 'no seeded interview without feedback');
    await page.goto(`/interviews/${found!.interview.id}/feedback`);
    await page.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(page.getByRole('alert')).toContainText('Add your own notes');
  });
});
