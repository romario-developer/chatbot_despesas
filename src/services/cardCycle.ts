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

function buildCyclePeriod(
  card: Pick<Card, 'closingDay' | 'dueDay'>,
  cycle: { startDate: string; endDate: string },
  tz: string,
): CardCyclePeriod {
  const cycleStart = dayjs.tz(cycle.startDate, 'YYYY-MM-DD', tz).startOf('day');
  const cycleEnd = dayjs.tz(cycle.endDate, 'YYYY-MM-DD', tz).startOf('day');
  const dueDate = resolveDueDate(cycleEnd, card.dueDay, card.closingDay);
  return { cycleStart, cycleEnd, dueDate };
}

export function getCardCycleForMonth(
  card: Pick<Card, 'closingDay' | 'dueDay'>,
  month: string,
  tz: string = TZ,
): CardCyclePeriod {
  const reference = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', tz);
  const cycle = getCardCycleRange(reference.toDate(), card.closingDay);
  return buildCyclePeriod(card, cycle, tz);
}

export function getOpenCycle(
  card: Pick<Card, 'closingDay' | 'dueDay'>,
  referenceDate: Date,
  tz: string = TZ,
): CardCyclePeriod {
  const cycle = getCardCycleRange(referenceDate, card.closingDay);
  return buildCyclePeriod(card, cycle, tz);
}
