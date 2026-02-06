import { z } from 'zod';

const MONTH_REGEX = /^\d{4}-\d{2}$/;

function trimOptionalString(value: unknown) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export const monthParamSchema = z.object({
  month: z.preprocess((value) => trimOptionalString(value), z.string().regex(MONTH_REGEX, 'month deve usar YYYY-MM')).optional(),
});
