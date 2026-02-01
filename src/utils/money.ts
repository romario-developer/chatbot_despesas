export function parsePtBrMoneyToCents(value: string | number): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }

  if (typeof value !== 'string') return null;
  let normalized = value
    .replace(/R\$/gi, '')
    .replace(/\s+/g, '');

  if (!normalized) return null;

  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');

  if (hasComma) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  }

  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
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
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return null;
    return Math.round(amount * 100);
  }

  if (typeof amount === 'string') {
    return parsePtBrMoneyToCents(amount);
  }

  return null;
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
