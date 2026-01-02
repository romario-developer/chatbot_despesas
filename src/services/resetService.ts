import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { normalizeCategoryName } from '../utils/normalize';

const RESET_TOKEN_TTL_MS = 5 * 60 * 1000;

function randomToken() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeToken(token: string) {
  return token.trim().toUpperCase();
}

async function clearResetState(userId: number) {
  const session = await prisma.userSession.findUnique({ where: { userId } });
  if (!session) return;

  const data: Prisma.UserSessionUpdateInput = {
    resetToken: null,
    resetTokenExpiresAt: null,
  };

  if (!session.mode || session.mode === 'reset:pending') {
    data.mode = null;
    data.draftId = null;
  }

  await prisma.userSession.update({ where: { userId }, data });
}

export async function generateResetToken(userId: number) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await prisma.userSession.upsert({
    where: { userId },
    update: {
      mode: 'reset:pending',
      draftId: null,
      resetToken: token,
      resetTokenExpiresAt: expiresAt,
    },
    create: {
      userId,
      mode: 'reset:pending',
      draftId: null,
      resetToken: token,
      resetTokenExpiresAt: expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function cancelReset(userId: number) {
  await clearResetState(userId);
}

export async function confirmAndExecuteReset(
  userId: number,
  tokenInput: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' }
> {
  const session = await prisma.userSession.findUnique({ where: { userId } });
  if (!session?.resetToken || !session.resetTokenExpiresAt) {
    return { ok: false, reason: 'missing' };
  }

  const expectedToken = normalizeToken(session.resetToken);
  const providedToken = normalizeToken(tokenInput);
  const now = Date.now();

  if (session.resetTokenExpiresAt.getTime() < now) {
    await clearResetState(userId);
    return { ok: false, reason: 'expired' };
  }

  if (expectedToken !== providedToken) {
    await clearResetState(userId);
    return { ok: false, reason: 'invalid' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.expenseDraft.deleteMany({ where: { userId } });
    await tx.expense.deleteMany({ where: { userId } });
    await tx.category.deleteMany({ where: { userId } });
    await tx.userSession.deleteMany({ where: { userId } });

    await tx.category.create({
      data: {
        userId,
        name: 'Outros',
        normalizedName: normalizeCategoryName('Outros'),
      },
    });
  });

  return { ok: true };
}
