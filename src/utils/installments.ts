import { dayjs, TZ } from './dates';

const clampDay = (value: number) => {
  const parsed = Number.isInteger(value) ? value : 1;
  return Math.min(Math.max(parsed, 1), 31);
};

const formatMonthFromDate = (date: ReturnType<typeof dayjs>) => date.format('YYYY-MM');

export function splitInstallmentAmounts(amountCents: number, installments: number): number[] {
  const normalizedInstallments = Number.isInteger(installments) && installments > 0 ? installments : 1;
  const base = Math.floor(amountCents / normalizedInstallments);
  let remainder = amountCents - base * normalizedInstallments;
  const amounts: number[] = [];
  for (let i = 0; i < normalizedInstallments; i += 1) {
    const adjustment = remainder > 0 ? 1 : remainder < 0 ? -1 : 0;
    amounts.push(base + adjustment);
    remainder -= adjustment;
  }
  return amounts;
}

export function getInvoiceMonthForPurchase(
  date: Date,
  closingDay: number,
  tz: string = TZ,
): string {
  const normalizedClosing = clampDay(closingDay);
  const purchase = dayjs.tz(date, tz);
  const monthDays = purchase.endOf('month').date();
  const closingInMonth = Math.min(normalizedClosing, monthDays);
  if (purchase.date() <= closingInMonth) {
    return formatMonthFromDate(purchase);
  }
  return formatMonthFromDate(purchase.add(1, 'month'));
}

export function monthStartFromInvoiceMonth(month: string, tz: string = TZ) {
  return dayjs.tz(`${month}-01`, 'YYYY-MM-DD', tz).startOf('day');
}
