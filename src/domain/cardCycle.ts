import { dayjs, TZ } from '../utils/dates';

type CycleRange = { startDate: string; endDate: string };

function buildClosingDate(reference: ReturnType<typeof dayjs>, offset: number, closingDay: number) {
  const normalizedDay = Math.min(Math.max(closingDay, 1), 31);
  const target = reference.add(offset, 'month');
  const monthDays = target.endOf('month').date();
  const day = Math.min(normalizedDay, monthDays);
  return target.date(day).startOf('day');
}

export function getCardCycleRange(referenceDate: Date, closingDay: number): CycleRange {
  const reference = dayjs(referenceDate).tz(TZ);
  const normalizedDay = Math.min(Math.max(closingDay, 1), 31);
  const today = reference.date();
  const currentClosing = buildClosingDate(reference, 0, normalizedDay);

  if (today <= normalizedDay) {
    const previousClosing = buildClosingDate(reference, -1, normalizedDay);
    const start = previousClosing.add(1, 'day');
    return {
      startDate: start.format('YYYY-MM-DD'),
      endDate: currentClosing.format('YYYY-MM-DD'),
    };
  }

  const nextClosing = buildClosingDate(reference, 1, normalizedDay);
  const start = currentClosing.add(1, 'day');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: nextClosing.format('YYYY-MM-DD'),
  };
}
