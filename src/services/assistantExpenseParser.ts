import type { PaymentMethod } from '@prisma/client';

import { classifyCategoryByText } from './categoryClassifier';
import { findCategoryById } from './categoryService';
import { findCardByNameGuess } from './cardService';
import { parsePtBrMoneyToCents } from '../utils/money';
import { dayjs, normalizeDateOnly, nowBahia, TZ } from '../utils/dates';

const PAYMENT_METHOD_PATTERNS: Array<{ method: PaymentMethod; keywords: string[] }> = [
  { method: 'PIX', keywords: ['pix'] },
  { method: 'DEBIT', keywords: ['debito', 'débito', 'cartao debito', 'cartão de débito'] },
  { method: 'CREDIT', keywords: ['credito', 'crédito', 'cartao credito', 'cartão de crédito'] },
  { method: 'CASH', keywords: ['dinheiro', 'cash'] },
];

const CATEGORY_DICTIONARY: Array<{ keywords: string[]; name: string }> = [
  { keywords: ['diesel', 'gasolina', 'combustivel'], name: 'Combustível' },
  { keywords: ['mercado', 'supermercado'], name: 'Alimentação' },
  { keywords: ['funcionario', 'diaria', 'pagamento'], name: 'Funcionários' },
  { keywords: ['racao', 'animal', 'vacina'], name: 'Animais' },
  { keywords: ['energia', 'luz', 'agua', 'internet'], name: 'Contas' },
];

const NORMALIZED_FIELDS = ['cartao', 'cartão', 'cartoes', 'cartões'] as const;

type ParsedExpenseMessage = {
  amountCents?: number;
  paymentMethod?: PaymentMethod;
  cardId?: number;
  date?: Date;
  dateProvided?: boolean;
  description?: string;
  categoryName?: string;
  installmentsTotal?: number;
};

function normalizeForMatching(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function removeSegment(source: string, segment: string) {
  if (!segment) return source;
  const normalizedSource = normalizeForMatching(source);
  const normalizedSegment = normalizeForMatching(segment);
  const index = normalizedSource.indexOf(normalizedSegment);
  if (index === -1) return source;
  return `${source.slice(0, index)} ${source.slice(index + segment.length)}`.trim();
}

function detectPaymentMethod(text: string): { method: PaymentMethod; matchedText: string } | null {
  const normalized = normalizeForMatching(text);
  for (const pattern of PAYMENT_METHOD_PATTERNS) {
    for (const keyword of pattern.keywords) {
      const normalizedKeyword = normalizeForMatching(keyword);
      const index = normalized.indexOf(normalizedKeyword);
      if (index === -1) continue;
      const matched = text.slice(index, index + keyword.length);
      return { method: pattern.method, matchedText: matched };
    }
  }
  return null;
}

function extractAmount(text: string) {
  const match = text.match(/(?:r\$)?\s*\d+(?:[\.,]\d{1,2})?/i);
  if (!match) return null;
  const value = match[0].trim();
  const cents = parsePtBrMoneyToCents(value);
  if (cents === null || cents <= 0) return null;
  return { amountCents: cents, matchedText: value };
}

function detectInstallments(text: string) {
  const match = text.match(/(?:em\s+)?(\d{1,2})\s*[xX]\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isInteger(parsed) || parsed <= 1) return null;
  const limited = Math.min(parsed, 36);
  return { total: limited, matchedText: match[0] };
}

function parseDateFromMessage(text: string) {
  const lower = text.toLowerCase();
  const today = nowBahia().startOf('day');

  const keywordMatch = (pattern: RegExp, adjust: (base: typeof today) => typeof today) => {
    const match = text.match(pattern);
    if (!match) return null;
    const parsed = adjust(today);
    const date = normalizeDateOnly(parsed.toDate());
    if (!date) return null;
    return { date, matchedText: match[0] };
  };

  if (lower.includes('hoje')) {
    return keywordMatch(/hoje/i, (base) => base);
  }
  if (lower.includes('ontem')) {
    return keywordMatch(/ontem/i, (base) => base.subtract(1, 'day'));
  }
  if (lower.includes('amanh')) {
    return keywordMatch(/amanh[ãa]/i, (base) => base.add(1, 'day'));
  }

  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const parsed = dayjs.tz(`${year}-${month}-${day}`, 'YYYY-MM-DD', TZ);
    if (parsed.isValid()) {
      const date = normalizeDateOnly(parsed.toDate());
      if (date) return { date, matchedText: isoMatch[0] };
    }
  }

  const fullMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (fullMatch) {
    const [, day, month, year] = fullMatch;
    const parsed = dayjs.tz(`${year}-${month}-${day}`, 'YYYY-MM-DD', TZ);
    if (parsed.isValid()) {
      const date = normalizeDateOnly(parsed.toDate());
      if (date) return { date, matchedText: fullMatch[0] };
    }
  }

  const shortMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
  if (shortMatch) {
    const [, day, month] = shortMatch;
    const year = today.year();
    const parsed = dayjs.tz(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, 'YYYY-MM-DD', TZ);
    if (parsed.isValid()) {
      const date = normalizeDateOnly(parsed.toDate());
      if (date) return { date, matchedText: shortMatch[0] };
    }
  }

  const dayOf = text.match(/\bdia\s+(\d{1,2})(?:[\/-](\d{1,2}))?\b/i);
  if (dayOf) {
    const [, day, month] = dayOf;
    const targetMonth = month ? month : (today.month() + 1).toString();
    const year = today.year();
    const parsed = dayjs.tz(`${year}-${targetMonth.padStart(2, '0')}-${day.padStart(2, '0')}`, 'YYYY-MM-DD', TZ);
    if (parsed.isValid()) {
      const date = normalizeDateOnly(parsed.toDate());
      if (date) return { date, matchedText: dayOf[0] };
    }
  }

  return null;
}

async function inferCategoryName(userId: number, text: string | undefined) {
  const candidate = text?.trim();
  if (!candidate) return undefined;

  const classification = await classifyCategoryByText(userId, candidate);
  if (classification) {
    const category = await findCategoryById(userId, classification.categoryId);
    if (category) return category.name;
  }

  const normalized = normalizeForMatching(candidate);
  for (const entry of CATEGORY_DICTIONARY) {
    if (entry.keywords.some((keyword) => normalized.includes(keyword))) {
      return entry.name;
    }
  }

  return undefined;
}

async function detectCard(text: string, userId: number) {
  const card = await findCardByNameGuess(userId, text);
  if (!card) return null;
  return { id: card.id, name: card.name };
}

export async function parseExpenseMessage(message: string, userId: number): Promise<ParsedExpenseMessage> {
  let cleaned = message.trim();
  const parsedDate = parseDateFromMessage(cleaned);
  if (parsedDate?.matchedText) {
    cleaned = removeSegment(cleaned, parsedDate.matchedText);
  }

  const paymentMethod = detectPaymentMethod(cleaned);
  if (paymentMethod) {
    cleaned = removeSegment(cleaned, paymentMethod.matchedText);
  }

  const card = await detectCard(cleaned, userId);
  if (card) {
    cleaned = removeSegment(cleaned, card.name);
    for (const marker of NORMALIZED_FIELDS) {
      cleaned = removeSegment(cleaned, marker);
    }
  }

  const amount = extractAmount(cleaned);
  if (amount?.matchedText) {
    cleaned = removeSegment(cleaned, amount.matchedText);
  }

  const installmentInfo = detectInstallments(cleaned);
  if (installmentInfo) {
    cleaned = removeSegment(cleaned, installmentInfo.matchedText);
  }

  const description = cleaned.replace(/\s+/g, ' ').trim() || undefined;
  const categoryName = await inferCategoryName(userId, description ?? message);

  return {
    amountCents: amount?.amountCents,
    paymentMethod: paymentMethod?.method,
    cardId: card?.id,
    date: parsedDate?.date ?? undefined,
    dateProvided: Boolean(parsedDate),
    description,
    categoryName,
    installmentsTotal: installmentInfo?.total,
  };
}

export type ParsedExpenseResult = ParsedExpenseMessage;
