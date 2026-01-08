import { prisma } from '../db/prisma';

export type SessionMode =
  | 'edit:value'
  | 'edit:category'
  | 'edit:description'
  | 'edit:date'
  | 'confirm:delete'
  | 'reset:pending';

export async function getSessionByUserId(userId: number) {
  const session = await prisma.userSession.findUnique({ where: { userId } });
  return { session, userId };
}

export async function setSession(userId: number, mode: SessionMode, draftId: string) {
  await prisma.userSession.upsert({
    where: { userId },
    update: { mode, draftId, resetToken: null, resetTokenExpiresAt: null },
    create: { userId, mode, draftId, resetToken: null, resetTokenExpiresAt: null },
  });
}

export async function clearSession(userId: number) {
  const { session } = await getSessionByUserId(userId);
  if (!session) return;
  await prisma.userSession.delete({ where: { userId } });
}
