const PAYMENT_METHODS = ["CASH", "DEBIT", "CREDIT", "PIX", "TRANSFER", "OTHER"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DEFAULT_PAYMENT_METHOD: PaymentMethod = "OTHER";

const PAYMENT_METHOD_SET = new Set<string>(PAYMENT_METHODS);

function removeDiacritics(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizePaymentMethod(value: unknown): PaymentMethod | null {
  if (typeof value !== "string") return null;
  const normalized = removeDiacritics(value.trim()).toUpperCase();
  if (!PAYMENT_METHOD_SET.has(normalized)) return null;
  return normalized as PaymentMethod;
}
