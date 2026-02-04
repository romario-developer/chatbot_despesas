import { prisma } from '../infra/db/prisma';
import { toCentsBRL } from '../utils/money';

export const PLANNING_FORMAT_VERSION = 2;

export type PlanningData = {
  salaryByMonth: Record<string, number>;
  extrasByMonth: Record<string, { id: string; label?: string; amount: number }[]>;
  fixedBills: { id: string; label?: string; amount: number }[];
  formatVersion?: number;
};

export const DEFAULT_PLANNING: PlanningData = {
  salaryByMonth: {},
  extrasByMonth: {},
  fixedBills: [],
  formatVersion: PLANNING_FORMAT_VERSION,
};

export async function getPlanningByUserId(userId: number): Promise<PlanningData> {
  const planning = await prisma.planning.findUnique({ where: { userId } });
  if (!planning) return DEFAULT_PLANNING;

  const data = planning.data as PlanningData | null;
  if (!data) return DEFAULT_PLANNING;
  if (data.formatVersion === PLANNING_FORMAT_VERSION) {
    return data;
  }
  const migrated = migratePlanningData(data);
  await prisma.planning.update({
    where: { userId },
    data: migrated,
  });
  return migrated;
}

export async function upsertPlanning(userId: number, data: PlanningData): Promise<PlanningData> {
  const payload: PlanningData = {
    ...data,
    formatVersion: PLANNING_FORMAT_VERSION,
  };
  await prisma.planning.upsert({
    where: { userId },
    update: { data: payload },
    create: { userId, data: payload },
  });
  return payload;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function convertPlanningAmount(value: unknown): number {
  const cents = toCentsBRL(value);
  if (cents === null || cents < 0) return 0;
  return cents;
}

function migratePlanningData(raw: PlanningData): PlanningData {
  const salaryByMonth: Record<string, number> = {};
  for (const [month, value] of Object.entries(raw.salaryByMonth ?? {})) {
    salaryByMonth[month] = convertPlanningAmount(value);
  }

  const extrasByMonth: Record<string, { id: string; label?: string; amount: number }[]> = {};
  for (const [month, items] of Object.entries(raw.extrasByMonth ?? {})) {
    if (!Array.isArray(items)) continue;
    extrasByMonth[month] = items.map((item) => ({
      id: item.id,
      label: item.label,
      amount: convertPlanningAmount(item.amount),
    }));
  }

  const fixedBills = (raw.fixedBills ?? []).map((bill) => ({
    id: bill.id,
    label: bill.label,
    amount: convertPlanningAmount(bill.amount),
  }));

  return {
    salaryByMonth,
    extrasByMonth,
    fixedBills,
    formatVersion: PLANNING_FORMAT_VERSION,
  };
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
