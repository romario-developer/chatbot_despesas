import { prisma } from '../db/prisma';
import { normalizeCategoryName } from '../utils/normalize';

export async function getOrCreateCategory(userId: number, name: string) {
  const normalizedName = normalizeCategoryName(name);

  return prisma.category.upsert({
    where: { userId_normalizedName: { userId, normalizedName } },
    update: {},
    create: {
      userId,
      name: name.trim(),
      normalizedName,
    },
  });
}

export async function ensureDefaultCategory(userId: number) {
  return getOrCreateCategory(userId, 'Outros');
}

export async function listCategories(userId: number) {
  return prisma.category.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
  });
}
