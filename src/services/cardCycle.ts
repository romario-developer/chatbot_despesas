import type { Card } from '@prisma/client';
import { dayjs, TZ } from '../utils/dates';
import { getCardCycleRange } from '../domain/cardCycle';
import type { Dayjs } from 'dayjs';

export type CardCyclePeriod = {
  cycleStart: Dayjs;
  cycleEnd: Dayjs;
  dueDate: Dayjs;
};

const clampDay = (value: number) => {
  const parsed = Number.isInteger(value) ? value : 1;
  return Math.min(Math.max(parsed, 1), 31);
};

function buildMonthClosingDate(base: Dayjs, closingDay: number) {
  const monthDays = base.endOf('month').date();
  const day = Math.min(clampDay(closingDay), monthDays);
  return base.date(day).endOf('day');
}

function buildCycleForClosingMonth(month: string, closingDay: number, tz: string) {
  const currentMonth = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', tz);
  const previousMonth = currentMonth.subtract(1, 'month');
  const currentClosing = buildMonthClosingDate(currentMonth, closingDay);
  const previousClosing = buildMonthClosingDate(previousMonth, closingDay);
  const start = previousClosing.add(1, 'millisecond').startOf('day');
  return { start, end: currentClosing };
}

function resolveDueDate(cycleEnd: Dayjs, dueDay: number, closingDay: number) {
  const normalizedDue = clampDay(dueDay);
  const normalizedClosing = clampDay(closingDay);
  let candidate = cycleEnd.clone();
  if (normalizedDue < normalizedClosing) {
    candidate = candidate.add(1, 'month');
  }
  const monthDays = candidate.endOf('month').date();
  const day = Math.min(normalizedDue, monthDays);
  return candidate.date(day).startOf('day');
}

export function getCardCycleForMonth(
  card: Pick<Card, 'closingDay' | 'dueDay'>,
  month: string,
  tz: string = TZ,
): CardCyclePeriod {
  const range = buildCycleForClosingMonth(month, card.closingDay, tz);
  const cycleEnd = range.end.clone().tz(tz);
  const cycleStart = range.start.clone().tz(tz);
  const dueDate = resolveDueDate(range.end, card.dueDay, card.closingDay);
  return { cycleStart, cycleEnd, dueDate };
}

export function getCurrentOpenCycle(
  card: Pick<Card, 'closingDay' | 'dueDay'>,
  referenceDate: Date,
  tz: string = TZ,
): CardCyclePeriod {
  const cycle = getCardCycleRange(referenceDate, card.closingDay);
  const cycleStart = dayjs.tz(cycle.startDate, 'YYYY-MM-DD', tz).startOf('day');
  const cycleEnd = dayjs.tz(cycle.endDate, 'YYYY-MM-DD', tz).endOf('day');
  const dueDate = resolveDueDate(cycleEnd, card.dueDay, card.closingDay);
  return { cycleStart, cycleEnd, dueDate };
}
