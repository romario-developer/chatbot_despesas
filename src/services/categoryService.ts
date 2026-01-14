import { prisma } from '../db/prisma';
import type { Category } from '@prisma/client';
import { normalizeCategoryName } from '../utils/normalize';

export type CategoryListItem = Pick<Category, 'id' | 'name' | 'normalizedName' | 'isActive'>;
export type CategoryConflict = { id: number; name: string };
export type CategoryCreationResult = { category: CategoryListItem } | { conflict: CategoryConflict };
export type CategoryUpdateResult = Category | { conflict: CategoryConflict } | null;
export type CategoryDeletionResult = { inUse: true; count: number } | { deleted: true } | null;

export async function getOrCreateCategory(userId: number, name: string) {
  const normalizedName = normalizeCategoryName(name);

  return prisma.category.upsert({
    where: { userId_normalizedName: { userId, normalizedName } },
    update: { isActive: true },
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

export async function listCategories(userId: number, options?: { active?: boolean }) {
  const whereClause: { userId: number; isActive?: boolean } = { userId };
  if (typeof options?.active === 'boolean') {
    whereClause.isActive = options.active;
  }
  return prisma.category.findMany({
    where: whereClause,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, normalizedName: true, isActive: true },
  });
}

export async function findCategoryById(userId: number, categoryId: number) {
  return prisma.category.findFirst({
    where: { userId, id: categoryId },
  });
}

export async function createCategory(userId: number, name: string): Promise<CategoryCreationResult> {
  const normalizedName = normalizeCategoryName(name);
  const existing = await prisma.category.findFirst({
    where: { userId, normalizedName },
    select: { id: true, name: true },
  });
  if (existing) {
    return { conflict: { id: existing.id, name: existing.name } };
  }
  const category = await prisma.category.create({
    data: { userId, name: name.trim(), normalizedName },
    select: { id: true, name: true, normalizedName: true, isActive: true },
  });
  return { category };
}

export async function updateCategory(
  userId: number,
  categoryId: number,
  data: { name?: string; isActive?: boolean },
): Promise<CategoryUpdateResult> {
  const updateData: { name?: string; normalizedName?: string; isActive?: boolean } = {};
  if (typeof data.name === 'string') {
    updateData.name = data.name.trim();
    updateData.normalizedName = normalizeCategoryName(data.name);
  }
  if (typeof data.isActive === 'boolean') {
    updateData.isActive = data.isActive;
  }

  if (updateData.normalizedName) {
    const conflict = await prisma.category.findFirst({
      where: {
        userId,
        normalizedName: updateData.normalizedName,
        NOT: { id: categoryId },
      },
    });
    if (conflict) {
      return { conflict: { id: conflict.id, name: conflict.name } };
    }
  }

  const updated = await prisma.category.updateMany({
    where: { userId, id: categoryId },
    data: updateData,
  });
  if (!updated.count) return null;
  return findCategoryById(userId, categoryId);
}

export async function deleteCategory(
  userId: number,
  categoryId: number,
): Promise<CategoryDeletionResult> {
  const expenseCount = await prisma.expense.count({
    where: { userId, categoryId },
  });
  if (expenseCount > 0) {
    return { inUse: true, count: expenseCount };
  }
  const deleted = await prisma.category.deleteMany({
    where: { userId, id: categoryId },
  });
  return deleted.count > 0 ? { deleted: true } : null;
}
