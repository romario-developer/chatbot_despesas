import { findUserByTelegramIdentifiers } from '../services/telegramLinkService';

export type LinkedTelegramUser = {
  id: number;
  telegramId: string;
  telegramChatId: string | null;
};

export function getTelegramIdCandidates(ctx: any): string[] {
  const candidates = new Set<string>();
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (typeof chatId !== 'undefined' && chatId !== null) {
    candidates.add(String(chatId));
  }
  const fromId = ctx.from?.id;
  if (typeof fromId !== 'undefined' && fromId !== null) {
    candidates.add(String(fromId));
  }
  return Array.from(candidates);
}

export async function resolveLinkedUser(ctx: any): Promise<LinkedTelegramUser | null> {
  const candidates = getTelegramIdCandidates(ctx);
  if (!candidates.length) return null;
  return findUserByTelegramIdentifiers(candidates);
}
