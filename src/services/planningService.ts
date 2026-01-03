import { prisma } from '../db/prisma';

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
