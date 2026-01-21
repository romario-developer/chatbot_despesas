import { dayjs, TZ } from "./dates";

export const APP_TZ = TZ;

type Range = { start: Date; endExclusive: Date };
const MONTH_PARAM_REGEX = /^\d{4}-\d{2}$/;

function toStartOfDay(value: string, tz: string) {
  const parsed =
    /^\d{4}-\d{2}-\d{2}$/.test(value) && value.length === 10
      ? dayjs.tz(value, "YYYY-MM-DD", tz)
      : dayjs.tz(value, tz);
  if (!parsed.isValid()) return null;
  return parsed.startOf("day");
}

export function getDayRangeTZ(baseDate: Date = new Date(), tz: string = APP_TZ): Range {
  const start = dayjs(baseDate).tz(tz).startOf("day");
  const endExclusive = start.add(1, "day");
  return { start: start.toDate(), endExclusive: endExclusive.toDate() };
}

export function getMonthRangeTZ(baseDate: Date = new Date(), tz: string = APP_TZ): Range {
  const start = dayjs(baseDate).tz(tz).startOf("month").startOf("day");
  const endExclusive = start.add(1, "month").startOf("day");
  return { start: start.toDate(), endExclusive: endExclusive.toDate() };
}

export function getMonthRangeFromMonthYear(
  month: number,
  year: number,
  tz: string = APP_TZ,
): Range {
  const start = dayjs.tz({ year, month: month - 1, day: 1 }, tz).startOf("day");
  const endExclusive = start.add(1, "month").startOf("day");
  return { start: start.toDate(), endExclusive: endExclusive.toDate() };
}

export function getMonthRangeFromIsoMonth(month: string, tz: string = APP_TZ): Range {
  if (!MONTH_PARAM_REGEX.test(month)) {
    throw new Error('Parametro "month" invalido. Use YYYY-MM.');
  }
  const parsed = dayjs.tz(`${month}-01`, "YYYY-MM-DD", tz);
  if (!parsed.isValid()) {
    throw new Error('Parametro "month" invalido.');
  }
  return getMonthRangeFromMonthYear(parsed.month() + 1, parsed.year(), tz);
}

export function parseFromToQuery(
  from?: string | string[],
  to?: string | string[],
  tz: string = APP_TZ,
): { start?: Date; endExclusive?: Date; error?: string } {
  const fromStr = Array.isArray(from) ? from[0] : from;
  const toStr = Array.isArray(to) ? to[0] : to;

  let start: Date | undefined;
  let endExclusive: Date | undefined;

  if (fromStr) {
    const parsed = toStartOfDay(fromStr, tz);
    if (!parsed) return { error: 'Parametro "from" invalido. Use YYYY-MM-DD.' };
    start = parsed.toDate();
  }

  if (toStr) {
    const parsed = toStartOfDay(toStr, tz);
    if (!parsed) return { error: 'Parametro "to" invalido. Use YYYY-MM-DD.' };
    endExclusive = parsed.add(1, "day").startOf("day").toDate();
  }

  return { start, endExclusive };
}
