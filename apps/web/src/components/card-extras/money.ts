/** Formats an amount in its currency; falls back to a plain number when the code is unknown. */
export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return 'Not given';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? 'USD',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString('en-US')}${currency ? ` ${currency}` : ''}`;
  }
}

export function formatRange(
  min: number | null,
  max: number | null,
  currency: string | null,
): string {
  if (min === null && max === null) return 'Not posted';
  if (min !== null && max !== null && min !== max)
    return `${formatMoney(min, currency)} to ${formatMoney(max, currency)}`;
  return formatMoney(min ?? max, currency);
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
