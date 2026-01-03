import { randomInt } from 'crypto';

import { prisma } from '../db/prisma';

const CODE_TTL_MINUTES = 10;

function generateCode(): string {
  const num = randomInt(0, 10 ** 6);
  return String(num).padStart(6, '0');
}

export async function createLinkCode(userId: number) {
  const now = new Date();
  const existing = await prisma.telegramLinkCode.findFirst({
    where: { userId },
    orderBy: { expiresAt: 'desc' },
  });

  if (existing && existing.expiresAt > now) {
    return { code: existing.code, expiresAt: existing.expiresAt };
  }

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
        continue;
      }
      throw err;
    }
  }

  throw new Error('Nao foi possivel gerar codigo. Tente novamente.');
}

type ConsumeLinkResult =
  | { ok: true; userId: number }
  | { ok: false; reason: 'invalid_or_expired' | 'chat_already_linked' };

export async function consumeLinkCode(telegramChatId: string, code: string): Promise<ConsumeLinkResult> {
  const record = await prisma.telegramLinkCode.findUnique({ where: { code } });
  if (!record) return { ok: false, reason: 'invalid_or_expired' };

  const now = new Date();
  if (record.expiresAt <= now) {
    await prisma.telegramLinkCode.delete({ where: { code } });
    return { ok: false, reason: 'invalid_or_expired' };
  }

  const existing = await prisma.user.findFirst({
    where: { telegramChatId },
    select: { id: true },
  });

  if (existing && existing.id !== record.userId) {
    return { ok: false, reason: 'chat_already_linked' };
  }

  await prisma.$transaction([
    prisma.telegramLinkCode.delete({ where: { code } }),
    prisma.user.update({
      where: { id: record.userId },
      data: { telegramChatId },
    }),
  ]);

  return { ok: true, userId: record.userId };
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
