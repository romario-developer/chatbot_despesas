const DIACRITICS_REGEX = /[\u0300-\u036f]/gi;
const WORD_CHAR_REGEX = /[a-z0-9]/;

type NormalizedMap = { normalized: string; positions: { start: number; end: number }[] };
type Range = { start: number; end: number };

const PAYMENT_RULES = [
  { method: 'PIX', tokens: ['pix'] },
  { method: 'CASH', tokens: ['dinheiro', 'cash'] },
  { method: 'DEBIT', tokens: ['cartao debito', 'cartão débito', 'cartao débito', 'cartao debito', 'debito', 'débito'] },
  {
    method: 'CREDIT',
    tokens: [
      'cartao credito',
      'cartão crédito',
      'cartao crédito',
      'cartao',
      'cartão',
      'credito',
      'crédito',
    ],
  },
  { method: 'TRANSFER', tokens: ['transferencia', 'transferência', 'ted', 'doc'] },
] as const;

function normalizeTextForMatching(text: string): NormalizedMap {
  const normalizedParts: string[] = [];
  const positions: { start: number; end: number }[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const decomposed = char.normalize('NFD');
    const stripped = decomposed.replace(DIACRITICS_REGEX, '');
    if (!stripped) continue;
    for (let j = 0; j < stripped.length; j += 1) {
      normalizedParts.push(stripped[j].toLowerCase());
      positions.push({ start: index, end: index + 1 });
    }
  }

  return { normalized: normalizedParts.join(''), positions };
}

function escapeRegex(text: string) {
  return text.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function findTokenMatch(
  normalized: string,
  token: string,
  positions: { start: number; end: number }[],
): { range: Range } | null {
  const pattern = `(^|[^a-z0-9])(${escapeRegex(token)})($|[^a-z0-9])`;
  const regex = new RegExp(pattern, 'iu');
  const match = regex.exec(normalized);
  if (!match || typeof match.index !== 'number') {
    return null;
  }

  const prefixLength = match[1]?.length ?? 0;
  const tokenText = match[2] ?? '';
  const start = match.index + prefixLength;
  const end = start + tokenText.length;
  if (start >= end) return null;
  if (end > positions.length) return null;
  return { range: { start, end } };
}

function mapNormalizedRangeToOriginal(
  positions: { start: number; end: number }[],
  range: Range,
): Range | null {
  if (!positions.length) return null;
  const startEntry = positions[range.start];
  const endEntry = positions[range.end - 1];
  if (!startEntry || !endEntry) return null;
  return { start: startEntry.start, end: endEntry.end };
}

function skipNonWord(normalized: string, from: number) {
  let index = from;
  while (index < normalized.length && !WORD_CHAR_REGEX.test(normalized[index])) {
    index += 1;
  }
  return index;
}

function readWord(normalized: string, from: number): Range | null {
  let index = skipNonWord(normalized, from);
  if (index >= normalized.length) return null;
  const start = index;
  while (index < normalized.length && WORD_CHAR_REGEX.test(normalized[index])) {
    index += 1;
  }
  if (index <= start) return null;
  return { start, end: index };
}

function mergeRanges(ranges: Range[]): Range[] {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    if (!merged.length || range.start > merged[merged.length - 1].end) {
      merged.push({ ...range });
      continue;
    }
    merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, range.end);
  }
  return merged;
}

function removeRanges(text: string, ranges: Range[]): string {
  if (!ranges.length) return text;
  const merged = mergeRanges(ranges);
  let cursor = 0;
  let result = '';
  for (const range of merged) {
    result += text.slice(cursor, range.start);
    cursor = range.end;
  }
  result += text.slice(cursor);
  return result;
}

function normalizeCardName(cardName: string) {
  return cardName
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PaymentParseResult {
  paymentMethod?: (typeof PAYMENT_RULES)[number]['method'];
  cardNameGuess?: string;
  cleanedText: string;
}

export function parsePayment(text: string): PaymentParseResult {
  const trimmed = text.trim();
  const { normalized, positions } = normalizeTextForMatching(trimmed);
  const removals: Range[] = [];

  let paymentMethod: PaymentParseResult['paymentMethod'];
  let cardNameGuess: string | undefined;
  let cardRange: Range | null = null;
  let noRange: Range | null = null;

  for (const rule of PAYMENT_RULES) {
    for (const token of rule.tokens) {
      const match = findTokenMatch(normalized, token, positions);
      if (!match) continue;

      paymentMethod = rule.method;
      const methodRange = mapNormalizedRangeToOriginal(positions, match.range);
      if (methodRange) {
        removals.push(methodRange);
      }

      if (rule.method === 'CREDIT') {
        let searchIndex = match.range.end;
        const firstWord = readWord(normalized, searchIndex);
        if (firstWord) {
          const firstText = normalized.slice(firstWord.start, firstWord.end);
          if (firstText === 'no') {
            const nextWord = readWord(normalized, firstWord.end);
            if (nextWord) {
              cardRange = nextWord;
              const nextMethodRange = mapNormalizedRangeToOriginal(positions, nextWord);
              if (nextMethodRange) {
                removals.push(nextMethodRange);
              }
            }
            const noOriginal = mapNormalizedRangeToOriginal(positions, firstWord);
            if (noOriginal) {
              removals.push(noOriginal);
            }
          } else {
            cardRange = firstWord;
            const cardOriginal = mapNormalizedRangeToOriginal(positions, firstWord);
            if (cardOriginal) {
              removals.push(cardOriginal);
            }
          }
        }
      }

      if (cardRange) {
        const originalRange = mapNormalizedRangeToOriginal(positions, cardRange);
        if (originalRange) {
          const guess = normalizedCardName(trimmed.slice(originalRange.start, originalRange.end));
          if (guess) {
            cardNameGuess = guess;
          }
        }
      }

      const cleaned = removeRanges(trimmed, removals).replace(/\s+/g, ' ').trim();
      return {
        paymentMethod,
        cardNameGuess,
        cleanedText: cleaned || trimmed,
      };
    }
  }

  return { cleanedText: trimmed };
}
