export function amountStringToCents(raw: string): number | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/r\$\s*/g, '')
    .replace(/\s+/g, '');

  if (!cleaned) return null;

  let normalized = cleaned;
  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');

  if (hasComma && hasDot) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = normalized.replace(',', '.');
  }

  const amount = Number.parseFloat(normalized);
  if (Number.isNaN(amount)) return null;
  return Math.round(amount * 100);
}

export function toAmountCents(amount: unknown): number | null {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return null;
    return Math.round(amount * 100);
  }

  if (typeof amount === 'string') {
    return amountStringToCents(amount);
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
