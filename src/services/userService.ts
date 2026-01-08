import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';
import { ADMIN_TELEGRAM_ID } from '../utils/systemUsers';
import { normalizeEmail } from '../utils/email';

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
