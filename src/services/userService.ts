import { prisma } from '../db/prisma';
import { ADMIN_TELEGRAM_ID } from '../utils/systemUsers';

export async function getOrCreateUser(telegramId: string) {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ telegramId }, { telegramChatId: telegramId }],
    },
  });
  if (existing) return existing;

  return prisma.user.create({ data: { telegramId } });
}

export async function getAdminUser() {
  return getOrCreateUser(ADMIN_TELEGRAM_ID);
}
