function normalizeMoneyString(raw: string): string | null {
  const cleaned = raw.replace(/R\$/gi, '').replace(/\s+/g, '');
  if (!cleaned) return null;
  if (cleaned.includes(',')) {
    return cleaned.replace(/\./g, '').replace(',', '.');
  }
  return cleaned;
}

export function toCentsBRL(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }

  if (typeof value === 'string') {
    const normalized = normalizeMoneyString(value);
    if (!normalized) return null;
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 100);
  }

  return null;
}

export function parsePtBrMoneyToCents(value: string | number): number | null {
  return toCentsBRL(value);
}

export function amountStringToNumber(raw: string): number | null {
  const cents = parsePtBrMoneyToCents(raw);
  if (cents === null) return null;
  return Number((cents / 100).toFixed(2));
}

export function amountStringToCents(raw: string): number | null {
  return parsePtBrMoneyToCents(raw);
}

export function toAmountCents(amount: unknown): number | null {
  return toCentsBRL(amount);
}

export function assertValidAmountCents(
  value: unknown,
  context = 'amountCents',
  opts?: { allowZero?: boolean },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} ausente ou invalido`);
  }

  if (!Number.isInteger(value)) {
    throw new Error(`${context} deve ser inteiro em centavos`);
  }

  if (opts?.allowZero) {
    if (value < 0) {
      throw new Error(`${context} deve ser maior ou igual a zero`);
    }
  } else if (value <= 0) {
    throw new Error(`${context} deve ser maior que zero`);
  }

  return value;
}

export function centsToNumber(cents: number) {
  return Number((cents / 100).toFixed(2));
}

export function formatCurrency(amountCents: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(amountCents / 100);
}

export function formatCurrencyNumber(amount: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(amount);
}
