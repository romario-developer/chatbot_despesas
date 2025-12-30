import { prisma } from '../db/prisma';
import { getOrCreateUser } from './userService';

export type SessionMode =
  | 'edit:value'
  | 'edit:category'
  | 'edit:description'
  | 'edit:date'
  | 'confirm:delete';

export async function getSessionByTelegramId(telegramId: string) {
  const user = await getOrCreateUser(telegramId);
  const session = await prisma.userSession.findUnique({ where: { userId: user.id } });
  return { session, user };
}

export async function setSession(telegramId: string, mode: SessionMode, draftId: string) {
  const { user } = await getSessionByTelegramId(telegramId);
  await prisma.userSession.upsert({
    where: { userId: user.id },
    update: { mode, draftId },
    create: { userId: user.id, mode, draftId },
  });
}

export async function clearSession(telegramId: string) {
  const { user, session } = await getSessionByTelegramId(telegramId);
  if (!session) return;
  await prisma.userSession.delete({ where: { userId: user.id } });
}
