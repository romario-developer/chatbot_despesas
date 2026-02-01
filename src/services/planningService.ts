import { prisma } from '../infra/db/prisma';

export type PlanningData = {
  salaryByMonth: Record<string, number>;
  extrasByMonth: Record<string, { id: string; label?: string; amount: number }[]>;
  fixedBills: { id: string; label?: string; amount: number }[];
};

export const DEFAULT_PLANNING: PlanningData = {
  salaryByMonth: {},
  extrasByMonth: {},
  fixedBills: [],
};

export async function getPlanningByUserId(userId: number): Promise<PlanningData> {
  const planning = await prisma.planning.findUnique({ where: { userId } });
  if (!planning) return DEFAULT_PLANNING;

  const data = planning.data as PlanningData | null;
  return data ?? DEFAULT_PLANNING;
}

export async function upsertPlanning(userId: number, data: PlanningData): Promise<PlanningData> {
  await prisma.planning.upsert({
    where: { userId },
    update: { data },
    create: { userId, data },
  });
  return data;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

export async function setSalaryAmount(userId: number, month: string, amount: number) {
  const planning = await getPlanningByUserId(userId);
  planning.salaryByMonth[month] = amount;
  await upsertPlanning(userId, planning);
  return { month, amount };
}

export async function addExtraIncome(userId: number, month: string, amount: number, label?: string) {
  const planning = await getPlanningByUserId(userId);
  const extras = planning.extrasByMonth[month] ?? [];
  extras.push({ id: cryptoRandomId(), label, amount });
  planning.extrasByMonth[month] = extras;
  await upsertPlanning(userId, planning);
  return { month, amount, label };
}

export async function addFixedBill(userId: number, label: string, amount: number) {
  const planning = await getPlanningByUserId(userId);
  const normalized = label.trim().toLowerCase();
  const existing = planning.fixedBills.find((bill) => (bill.label ?? '').trim().toLowerCase() === normalized);
  if (existing) {
    existing.amount = amount;
  } else {
    planning.fixedBills.push({ id: cryptoRandomId(), label, amount });
  }
  await upsertPlanning(userId, planning);
  return { label, amount };
}
