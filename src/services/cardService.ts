import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';

export const CARD_SELECT = {
  id: true,
  name: true,
  brand: true,
  color: true,
  closingDay: true,
  dueDay: true,
} as const;

export type CardSummary = Prisma.CardGetPayload<{ select: typeof CARD_SELECT }>;

export async function findCardByIdForUser(userId: number, cardId: number) {
  return prisma.card.findFirst({
    where: { userId, id: cardId },
    select: CARD_SELECT,
  });
}

export async function findCardByNameGuess(userId: number, guess: string | undefined | null) {
  if (!guess) return null;
  const normalized = guess.trim();
  if (!normalized) return null;
  return prisma.card.findFirst({
    where: {
      userId,
      name: { contains: normalized, mode: 'insensitive' },
    },
    select: CARD_SELECT,
  });
}

export async function listCardsForUser(userId: number) {
  return prisma.card.findMany({
    where: { userId },
    select: CARD_SELECT,
    orderBy: { name: 'asc' },
  });
}
