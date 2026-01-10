const PAYMENT_METHODS = ['CASH', 'DEBIT', 'CREDIT', 'PIX', 'TRANSFER', 'OTHER'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DEFAULT_PAYMENT_METHOD: PaymentMethod = 'OTHER';

const PAYMENT_METHOD_SET = new Set<string>(PAYMENT_METHODS);

export function normalizePaymentMethod(value: unknown): PaymentMethod | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!PAYMENT_METHOD_SET.has(normalized)) return null;
  return normalized as PaymentMethod;
}
