export function amountStringToNumber(raw: string): number | null {
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
  return Number(amount.toFixed(2));
}

export function amountStringToCents(raw: string): number | null {
  const amount = amountStringToNumber(raw);
  if (amount === null) return null;
  return Math.round(amount * 100);
}

export function parseCurrencyInput(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Number(value.toFixed(2));
  }

  if (typeof value === "string") {
    return amountStringToNumber(value);
  }

  return null;
}

export function toAmountCents(amount: unknown): number | null {
  const parsed = parseCurrencyInput(amount);
  if (parsed === null) return null;
  return Math.round(parsed * 100);
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
