import { z } from 'zod';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function getSingleValue(value: unknown) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function trimmedOptionalString(value: unknown) {
  const single = getSingleValue(value);
  if (typeof single !== 'string') return undefined;
  const trimmed = single.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalPositiveInteger(value: unknown) {
  const single = getSingleValue(value);
  if (single === undefined || single === null) return single;
  if (typeof single === 'string') {
    const trimmed = single.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) ? parsed : single;
  }
  return single;
}

function optionalPositiveNumber(value: unknown) {
  const single = getSingleValue(value);
  if (single === undefined || single === null) return single;
  if (typeof single === 'string') {
    const trimmed = single.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : single;
  }
  return single;
}

const fromToSchema = (label: string) =>
  z.preprocess((value) => {
    const single = getSingleValue(value);
    if (typeof single !== 'string') return single;
    return single.trim();
  }, z.string().regex(DATE_ONLY_REGEX, `${label} deve usar o formato YYYY-MM-DD`));

const paymentMethodSchema = z.preprocess(
  (value) => trimmedOptionalString(value),
  z.string().optional(),
);

export const entriesListQuerySchema = z.object({
  from: fromToSchema('from'),
  to: fromToSchema('to'),
  category: z.preprocess((value) => trimmedOptionalString(value), z.string().optional()),
  q: z.preprocess((value) => trimmedOptionalString(value), z.string().optional()),
  source: z.preprocess((value) => trimmedOptionalString(value), z.string().optional()),
  cardId: z.preprocess(
    (value) => optionalPositiveInteger(value),
    z.union([z.number().int().positive(), z.null(), z.undefined()]),
  ),
  payment: z.preprocess((value) => trimmedOptionalString(value), paymentMethodSchema),
  paymentMethod: z.preprocess((value) => trimmedOptionalString(value), paymentMethodSchema),
});

const createAmountSchema = z.preprocess(
  (value) => optionalPositiveNumber(value),
  z.number().positive({ message: 'amount deve ser maior que zero' }),
);

const createDescriptionSchema = z
  .string()
  .min(1, 'description e obrigatoria')
  .transform((value) => value.trim());

const createDateSchema = z
  .string()
  .regex(DATE_ONLY_REGEX, 'date deve usar o formato YYYY-MM-DD')
  .transform((value) => value.trim());

const optionalCategorySchema = z.preprocess(
  (value) => trimmedOptionalString(value),
  z.string().optional(),
);

const optionalCardIdSchema = z.preprocess(
  (value) => optionalPositiveInteger(value),
  z.union([z.number().int().positive(), z.null(), z.undefined()]),
);

const optionalInstallmentsSchema = z.preprocess(
  (value) => optionalPositiveInteger(value),
  z.number().int().min(1).optional(),
);

export const entriesCreateBodySchema = z.object({
  amount: createAmountSchema,
  description: createDescriptionSchema,
  date: createDateSchema,
  category: optionalCategorySchema,
  paymentMethod: paymentMethodSchema,
  cardId: optionalCardIdSchema,
  installments: optionalInstallmentsSchema,
});

export const entriesUpdateBodySchema = z
  .object({
    amount: createAmountSchema.optional(),
    description: createDescriptionSchema.optional(),
    date: createDateSchema.optional(),
    category: optionalCategorySchema.optional(),
    paymentMethod: paymentMethodSchema.optional(),
    cardId: optionalCardIdSchema.optional(),
  })
  .refine((payload) => Object.values(payload).some((value) => value !== undefined), {
    message: 'Nenhum campo para atualizar',
  });

export const entryIdParamSchema = z.object({
  id: z
    .preprocess((value) => {
      const single = getSingleValue(value);
      if (typeof single === 'string') {
        const trimmed = single.trim();
        return trimmed === '' ? undefined : Number.parseInt(trimmed, 10);
      }
      return single;
    }, z.number().int().positive()),
});
