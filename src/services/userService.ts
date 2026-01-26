import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';
import { ADMIN_TELEGRAM_ID } from '../utils/systemUsers';
import { normalizeEmail } from '../utils/email';

export async function findUserBySubject(subject: string) {
  const normalized = subject?.trim();
  if (!normalized) return null;

  if (normalized === ADMIN_TELEGRAM_ID) {
    return getAdminUser();
  }

  const whereOr: Prisma.UserWhereInput[] = [];
  const asNumber = Number(normalized);
  if (!Number.isNaN(asNumber) && Number.isInteger(asNumber) && asNumber > 0) {
    whereOr.push({ id: asNumber });
  }

  const normalizedEmail = normalizeEmail(normalized);
  if (normalizedEmail) {
    whereOr.push({ email: normalizedEmail });
  }

  whereOr.push({ telegramId: normalized }, { telegramChatId: normalized });

  return prisma.user.findFirst({
    where: { OR: whereOr },
  });
}

export async function getOrCreateUser(telegramId: string) {
  const normalized = telegramId.trim();
  const normalizedEmail = normalizeEmail(normalized);

  const whereOr: Prisma.UserWhereInput[] = [
    { telegramId: normalized },
    { telegramChatId: normalized },
  ];
  if (normalizedEmail) {
    whereOr.push({ email: normalizedEmail });
  }

  const existing = await prisma.user.findFirst({
    where: { OR: whereOr },
  });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      telegramId: normalized,
      email: normalizedEmail ?? undefined,
    },
  });
}

export async function getAdminUser() {
  return getOrCreateUser(ADMIN_TELEGRAM_ID);
}
