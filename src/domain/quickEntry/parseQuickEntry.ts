import { amountStringToNumber, toAmountCents } from '../../utils/money';
import { dayjs, nowBahia, normalizeDateOnly, parseDateFromText, TZ } from '../../utils/dates';
import { PaymentMethod } from '../../utils/paymentMethod';

export type QuickEntryIssue = 'missing_description' | 'ambiguous_category';
export type QuickEntryConfidence = 'high' | 'medium' | 'low';

export interface ParsedQuickEntry {
  amount: number;
  amountCents: number;
  description: string;
  categoryName: string;
  date: Date;
  dateKey: string;
  month: string;
  rawText: string;
  confidence: QuickEntryConfidence;
  issues: QuickEntryIssue[];
  paymentMethod?: PaymentMethod;
  cardNameGuess?: string;
  cardId?: number | null;
  installmentsTotal?: number;
}

export type AmountMatchStrategy = 'first' | 'last';

export type CategoryResolverResult = {
  categoryName: string;
  cleanedText?: string;
};

export type CategoryResolver = (text: string) => CategoryResolverResult | null;

export type QuickEntryErrorCode = 'empty_text' | 'missing_amount' | 'invalid_amount';

export class QuickEntryParseError extends Error {
  code: QuickEntryErrorCode;

  constructor(code: QuickEntryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface QuickEntryParseOptions {
  amountMatchStrategy?: AmountMatchStrategy;
  categoryResolver?: CategoryResolver;
  defaultCategoryName?: string;
  defaultDescription?: string;
  messages?: {
    emptyText?: string;
    missingAmount?: string;
    invalidAmount?: string;
  };
}

const AMOUNT_REGEX =
  /(?:r\$?\s*)?-?\d{1,3}(?:[\.\s]\d{3})*(?:[.,]\d{1,2})|-?\d+(?:[.,]\d{1,2})?/gi;

function selectAmountMatch(rawText: string, strategy: AmountMatchStrategy): RegExpMatchArray | null {
  const matches = Array.from(rawText.matchAll(AMOUNT_REGEX));
  if (!matches.length) return null;
  return strategy === 'last' ? matches[matches.length - 1] : matches[0];
}

function removeMatch(text: string, match: RegExpMatchArray) {
  const index = typeof match.index === 'number' ? match.index : text.indexOf(match[0]);
  if (index < 0) return text;
  return `${text.slice(0, index)} ${text.slice(index + match[0].length)}`;
}

export function parseQuickEntryText(
  text: string,
  options: QuickEntryParseOptions = {},
): ParsedQuickEntry {
  const messages = {
    emptyText: 'Informe um texto com o gasto.',
    missingAmount: 'Informe um valor. Ex: mercado 50',
    invalidAmount: 'Valor invalido. Use 40 ou 40,50.',
    ...options.messages,
  };

  const rawText = text.trim();
  if (!rawText) {
    throw new QuickEntryParseError('empty_text', messages.emptyText);
  }

  const amountMatchStrategy = options.amountMatchStrategy ?? 'last';
  const amountMatch = selectAmountMatch(rawText, amountMatchStrategy);
  if (!amountMatch) {
    throw new QuickEntryParseError('missing_amount', messages.missingAmount);
  }

  const amount = amountStringToNumber(amountMatch[0]);
  if (amount === null) {
    throw new QuickEntryParseError('invalid_amount', messages.invalidAmount);
  }
  const amountCents = toAmountCents(amount);
  if (amountCents === null) {
    throw new QuickEntryParseError('invalid_amount', messages.invalidAmount);
  }

  let workingText = removeMatch(rawText, amountMatch);

  const dateInfo = parseDateFromText(workingText);
  if (dateInfo?.matchedText) {
    workingText = workingText.replace(dateInfo.matchedText, ' ');
  }
  const rawDate = dateInfo?.date ? dayjs(dateInfo.date) : nowBahia();
  const localDate = rawDate.tz(TZ);
  const dateKey = localDate.format('YYYY-MM-DD');
  const month = localDate.format('YYYY-MM');
  const date = normalizeDateOnly(dateKey, TZ) ?? localDate.toDate();

  const defaultCategoryName = options.defaultCategoryName ?? 'Outros';
  const resolver = options.categoryResolver;
  let categoryName = defaultCategoryName;
  let categoryText = workingText;

  if (resolver) {
    const resolved = resolver(workingText);
    if (resolved?.categoryName) {
      categoryName = resolved.categoryName;
      if (typeof resolved.cleanedText === 'string') {
        categoryText = resolved.cleanedText;
      }
    }
  }

  const cleanedDescription = categoryText.replace(/\s+/g, ' ').trim();
  const description = cleanedDescription || options.defaultDescription || 'Sem descricao';

  const issues: QuickEntryIssue[] = [];
  if (!cleanedDescription) issues.push('missing_description');
  if (categoryName.trim().toLowerCase() === defaultCategoryName.trim().toLowerCase()) {
    issues.push('ambiguous_category');
  }

  let confidence: QuickEntryConfidence = 'high';
  if (issues.length === 1) confidence = 'medium';
  if (issues.length >= 2) confidence = 'low';

  return {
    amount,
    amountCents,
    description,
    categoryName,
    date,
    dateKey,
    month,
    rawText,
    confidence,
    issues,
  };
}
