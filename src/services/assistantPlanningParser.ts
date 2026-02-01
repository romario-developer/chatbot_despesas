import { amountStringToCents } from '../utils/money';
import { dayjs } from '../utils/dates';

const MONTH_ALIASES: Record<string, number> = {
  janeiro: 1,
  jan: 1,
  fevereiro: 2,
  fev: 2,
  março: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  maio: 5,
  mai: 5,
  junho: 6,
  jun: 6,
  julho: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  setembro: 9,
  set: 9,
  outubro: 10,
  out: 10,
  novembro: 11,
  nov: 11,
  dezembro: 12,
  dez: 12,
};

type PlanningCommand =
  | 'set_salary'
  | 'add_extra_income'
  | 'add_fixed_bill';

export type PlanningParseResult = {
  kind: 'planning';
  planningAction: PlanningCommand;
  month: string;
  amount: number;
  label?: string;
  description?: string;
};

function normalizeMonth(text?: string): string | null {
  if (!text) return null;
  const normalized = text.toLowerCase().trim();
  const isoMatch = normalized.match(/(\d{4})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;

  const slashMatch = normalized.match(/(\d{2})\/(\d{4})/);
  if (slashMatch) {
    const [, month, year] = slashMatch;
    return `${year}-${month}`;
  }

  const words = normalized.split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    const candidate = words[i];
    if (MONTH_ALIASES[candidate] && words[i + 1] && /^\d{4}$/.test(words[i + 1])) {
      const monthNumber = MONTH_ALIASES[candidate].toString().padStart(2, '0');
      return `${words[i + 1]}-${monthNumber}`;
    }
    if (MONTH_ALIASES[candidate]) {
      const monthNumber = MONTH_ALIASES[candidate].toString().padStart(2, '0');
      const year = dayjs().year();
      return `${year}-${monthNumber}`;
    }
  }

  return null;
}

function detectAmount(text: string): { amountCents: number; cleaned: string } | null {
  const regex = /(?:r\$)?\s*\d+(?:[\.,]\d{1,2})?/gi;
  const matches = Array.from(text.matchAll(regex));
  const match = matches.pop();
  if (!match) return null;
  const amount = amountStringToCents(match[0]);
  if (!amount || amount <= 0) return null;
  return {
    amountCents: amount,
    cleaned: `${text.slice(0, match.index!)} ${text.slice(match.index! + match[0].length)}`.trim(),
  };
}

function stripPrefixes(text: string, prefixes: string[]) {
  let result = text;
  for (const prefix of prefixes) {
    const pattern = new RegExp(`^${prefix}\\s+`, 'i');
    if (pattern.test(result)) {
      result = result.replace(pattern, '').trim();
      break;
    }
  }
  return result;
}

export function parsePlanningMessage(message: string): PlanningParseResult | null {
  const normalized = message.toLowerCase();
  const amountMatch = detectAmount(message);
  if (!amountMatch) return null;

  const { amountCents, cleaned } = amountMatch;
  const month = normalizeMonth(message) ?? dayjs().format('YYYY-MM');

  if (normalized.includes('salario') || normalized.includes('salário')) {
    return {
      kind: 'planning',
      planningAction: 'set_salary',
      month,
      amount: amountCents,
    };
  }

  if (normalized.includes('entrada extra') || normalized.includes('extra')) {
    const description = stripPrefixes(cleaned, ['entrada extra', 'extra']) || undefined;
    return {
      kind: 'planning',
      planningAction: 'add_extra_income',
      month,
      amount: amountCents,
      description,
    };
  }

  if (normalized.includes('conta fixa') || normalized.includes('fixa') || normalized.includes('conta ')) {
    const label = stripPrefixes(cleaned, ['conta fixa', 'conta', 'fixa']);
    if (!label) return null;
    return {
      kind: 'planning',
      planningAction: 'add_fixed_bill',
      month,
      amount: amountCents,
      label,
    };
  }

  return null;
}
