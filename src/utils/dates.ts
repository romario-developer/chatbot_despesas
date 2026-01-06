import dayjsLib from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import objectSupport from 'dayjs/plugin/objectSupport';
import 'dayjs/locale/pt-br';

dayjsLib.extend(utc);
dayjsLib.extend(timezone);
dayjsLib.extend(customParseFormat);
dayjsLib.extend(objectSupport);
dayjsLib.locale('pt-br');

export const TZ = 'America/Bahia';
dayjsLib.tz.setDefault(TZ);

export const dayjs = dayjsLib;

export function nowBahia() {
  return dayjs.tz();
}

export function formatDate(date: Date) {
  return dayjs(date).tz(TZ).format('DD/MM/YYYY');
}

export function normalizeDateOnly(input: string | Date, tz: string = TZ): Date | null {
  let parsed: any = null;
  if (typeof input === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
      parsed = dayjs.tz(input.trim(), 'YYYY-MM-DD', tz);
    } else {
      parsed = dayjs.tz(input.trim(), tz);
    }
  } else {
    parsed = dayjs(input).tz(tz);
  }
  if (!parsed || !parsed.isValid()) return null;
  return parsed.hour(12).minute(0).second(0).millisecond(0).toDate();
}

export function parseDateFromText(text: string) {
  const normalized = text.toLowerCase();
  const today = nowBahia().startOf('day');

  if (normalized.includes('hoje')) {
    return { date: normalizeDateOnly(today.toDate()), matchedText: 'hoje' };
  }

  if (normalized.includes('ontem')) {
    return { date: normalizeDateOnly(today.subtract(1, 'day').toDate()), matchedText: 'ontem' };
  }

  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const parsed = dayjs.tz(`${y}-${m}-${d}`, 'YYYY-MM-DD', TZ);
    if (parsed.isValid()) {
      return { date: normalizeDateOnly(parsed.toDate()), matchedText: isoMatch[0] };
    }
  }

  const fullMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (fullMatch) {
    const [, d, m, y] = fullMatch;
    const parsed = dayjs.tz(`${y}-${m}-${d}`, 'YYYY-MM-DD', TZ);
    if (parsed.isValid()) {
      return { date: normalizeDateOnly(parsed.toDate()), matchedText: fullMatch[0] };
    }
  }

  const shortMatch = text.match(/\b(\d{1,2})\/(\d{1,2})(?!\/)\b/);
  if (shortMatch) {
    const [, d, m] = shortMatch;
    const parsed = dayjs.tz(`${today.year()}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, 'YYYY-MM-DD', TZ);
    if (parsed.isValid()) {
      return { date: normalizeDateOnly(parsed.toDate()), matchedText: shortMatch[0] };
    }
  }

  return null;
}

// getMonthRange deprecated: use dateRange helpers (getMonthRangeFromMonthYear)
