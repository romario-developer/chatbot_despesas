import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../infra/db/prisma';

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
  const migratedJson: Prisma.InputJsonValue = migrated;
  await prisma.planning.update({
    where: { userId },
    data: { data: migratedJson },
  });
  return migrated;
}

export async function upsertPlanning(userId: number, data: PlanningData): Promise<PlanningData> {
  const payload: PlanningData = {
    ...data,
    formatVersion: PLANNING_FORMAT_VERSION,
  };
  const payloadJson: Prisma.InputJsonValue = payload;
  await prisma.planning.upsert({
    where: { userId },
    update: { data: payloadJson },
    create: { userId, data: payloadJson },
  });
  return payload;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function generateId() {
  if (typeof randomUUID === 'function') return randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function convertPlanningAmount(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num);
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

export function normalizePlanningInput(input: unknown): PlanningData {
  const normalized: PlanningData = {
    salaryByMonth: {},
    extrasByMonth: {},
    fixedBills: [],
    formatVersion: PLANNING_FORMAT_VERSION,
  };

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const salaryInput = (input as Record<string, unknown>).salaryByMonth;
    if (salaryInput && typeof salaryInput === 'object') {
      for (const [key, value] of Object.entries(salaryInput as Record<string, unknown>)) {
        if (typeof key !== 'string') continue;
        normalized.salaryByMonth[key] = convertPlanningAmount(value);
      }
    }

    const extrasInput = (input as Record<string, unknown>).extrasByMonth;
    if (extrasInput && typeof extrasInput === 'object') {
      for (const [monthKey, extrasValue] of Object.entries(extrasInput as Record<string, unknown>)) {
        if (typeof monthKey !== 'string') continue;
        const items = Array.isArray(extrasValue) ? extrasValue : [];
        const normalizedItems: { id: string; label?: string; amount: number }[] = [];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const id =
            typeof (item as any).id === 'string' && (item as any).id.trim()
              ? (item as any).id
              : generateId();
          const label = typeof (item as any).label === 'string' ? (item as any).label : undefined;
          const amount = convertPlanningAmount((item as any).amount);
          normalizedItems.push({ id, label, amount });
        }
        normalized.extrasByMonth[monthKey] = normalizedItems;
      }
    }

    const fixedInput = (input as Record<string, unknown>).fixedBills;
    if (Array.isArray(fixedInput)) {
      const bills: { id: string; label?: string; amount: number }[] = [];
      for (const item of fixedInput) {
        if (!item || typeof item !== 'object') continue;
        const id =
          typeof (item as any).id === 'string' && (item as any).id.trim() ? (item as any).id : generateId();
        const label = typeof (item as any).label === 'string' ? (item as any).label : undefined;
        const amount = convertPlanningAmount((item as any).amount);
        bills.push({ id, label, amount });
      }
      normalized.fixedBills = bills;
    }
  }

  return normalized;
}

export async function savePlanningFromInput(userId: number, input: unknown) {
  const normalized = normalizePlanningInput(input);
  return upsertPlanning(userId, normalized);
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
