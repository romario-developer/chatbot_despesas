import { prisma } from '../db/prisma';

export async function getOrCreateUser(telegramId: string) {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ telegramId }, { telegramChatId: telegramId }],
    },
  });
  if (existing) return existing;

  return prisma.user.create({ data: { telegramId } });
}
