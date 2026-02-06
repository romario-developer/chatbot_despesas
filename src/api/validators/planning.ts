import { z } from 'zod';

const MONTH_REGEX = /^\d{4}-\d{2}$/;

const amountSchema = z.number().int().min(0);

const monthKeySchema = z.string().regex(MONTH_REGEX, 'Chave do mês deve usar YYYY-MM');

const planningItemSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  amount: amountSchema,
});

export const planningUpdateBodySchema = z.object({
  salaryByMonth: z.record(monthKeySchema, amountSchema).optional(),
  extrasByMonth: z.record(monthKeySchema, z.array(planningItemSchema)).optional(),
  fixedBills: z.array(planningItemSchema).optional(),
});
