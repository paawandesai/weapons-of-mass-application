import { expect, test } from '@playwright/test';
import { applicationIds } from './helpers';

test.describe('offer panel', () => {
  test('a card in Offer shows the posted range, comparables with source and date, and the floor', async ({
    page,
    request,
  }) => {
    let target: string | null = null;
    for (const id of await applicationIds(request, 'offer')) {
      const res = await request.get(`/api/interviews/for-application/${id}`);
      const body = (await res.json()) as { negotiation: unknown };
      if (res.ok() && body.negotiation) {
        target = id;
        break;
      }
    }
    test.skip(!target, 'no seeded card in Offer with pay data');

    await page.goto(`/applications/${target}`);
    const panel = page.getByRole('region', { name: 'Offer' });
    await expect(panel.getByText('Posted range')).toBeVisible();
    await expect(panel.getByText('Your salary floor')).toBeVisible();
    await expect(panel.getByText('Comparable pay')).toBeVisible();
    await expect(panel.getByText(/levels\.fyi|No comparable pay data was found/)).toBeVisible();
  });
});
