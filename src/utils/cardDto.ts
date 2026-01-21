import type { Card } from '@prisma/client';

import { centsToNumber } from './money';

export type CardDto = {
  id: number;
  userId: number;
  name: string;
  brand: string;
  limit: number;
  closingDay: number;
  dueDay: number;
  color: string;
  textColor: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InvoiceViewDto = {
  card: CardDto;
  cardId: number;
  cycleStart: string;
  cycleEnd: string;
  invoiceTotal: number;
  paidTotal: number;
  remaining: number;
  status: 'PAGA' | 'FECHADA' | 'ABERTA';
  statusCode: 'PAID' | 'CLOSED' | 'OPEN';
};

export function cardToDto(card: Card): CardDto {
  return {
    id: card.id,
    userId: card.userId,
    name: card.name,
    brand: card.brand,
    limit: centsToNumber(card.limit),
    closingDay: card.closingDay,
    dueDay: card.dueDay,
    color: card.color,
    textColor: card.textColor,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

export function logCardDebug(route: string, cards: CardDto[], meta?: Record<string, unknown>) {
  if (process.env.DEBUG_CARDS !== '1') return;
  const sample = cards.length ? cards[0] : null;
  console.log('[card-debug]', { route, count: cards.length, sample, ...meta });
}
