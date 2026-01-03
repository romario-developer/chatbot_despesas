import { prisma } from '../db/prisma';

const CODE_TTL_MINUTES = 10;

function generateCode(): string {
  const num = Math.floor(Math.random() * 10 ** 6);
  return String(num).padStart(6, '0');
}

export async function createLinkCode(userId: number) {
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
  await prisma.telegramLinkCode.deleteMany({ where: { userId } });

  for (let i = 0; i < 5; i += 1) {
    const code = generateCode();
    try {
      const saved = await prisma.telegramLinkCode.create({
        data: { code, userId, expiresAt },
      });
      return { code: saved.code, expiresAt: saved.expiresAt };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // collision, retry
        continue;
      }
      throw err;
    }
  }

  throw new Error('NÆo foi poss¡vel gerar c¢digo. Tente novamente.');
}

export async function consumeLinkCode(code: string) {
  const record = await prisma.telegramLinkCode.findUnique({ where: { code } });
  if (!record) return null;

  const now = new Date();
  if (record.expiresAt <= now) {
    await prisma.telegramLinkCode.delete({ where: { code } });
    return null;
  }

  await prisma.telegramLinkCode.delete({ where: { code } });
  return { userId: record.userId };
}

export async function linkChatToUser(userId: number, telegramChatId: string) {
  await prisma.user.updateMany({ where: { telegramChatId }, data: { telegramChatId: null } });
  return prisma.user.update({
    where: { id: userId },
    data: { telegramChatId },
  });
}

export async function findUserIdByChatId(telegramChatId: string) {
  const user = await prisma.user.findFirst({ where: { telegramChatId }, select: { id: true } });
  return user?.id ?? null;
}

export async function getLinkStatus(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramChatId: true },
  });

  return { linked: Boolean(user?.telegramChatId), telegramChatId: user?.telegramChatId ?? null };
}
