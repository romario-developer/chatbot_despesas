import { prisma } from '../db/prisma';

export async function getOrCreateUser(telegramId: string) {
  return prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
}
