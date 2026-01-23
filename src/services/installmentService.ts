import { prisma } from '../db/prisma';
import { dayjs, TZ } from '../utils/dates';
import { PaymentMethod } from '../utils/paymentMethod';
import { CARD_SELECT } from './cardService';

type CreateInstallmentOptions = {
  userId: number;
  cardId: number;
  categoryId: number;
  description: string;
  amountCents: number;
  date: Date;
  rawText: string;
  purchaseLabel: string;
  source?: string;
  paymentMethod: PaymentMethod;
  installmentsTotal: number;
  appendInstallmentLabel?: boolean;
};

const DEFAULT_SOURCE = 'manual';

function buildInstallmentDate(base: ReturnType<typeof dayjs>, offset: number) {
  const candidate = base.add(offset, 'month');
  const desired = Math.min(base.date(), candidate.endOf('month').date());
  return candidate.date(desired).startOf('day');
}

export interface CreateInstallmentResult {
  groupId: string;
  expenses: Awaited<ReturnType<typeof prisma.expense.create>>[];
  amounts: number[];
}

export async function createInstallmentExpenses(options: CreateInstallmentOptions) {
  const {
    userId,
    cardId,
    categoryId,
    description,
    amountCents,
    date,
    rawText,
    purchaseLabel,
    paymentMethod,
    installmentsTotal,
    appendInstallmentLabel = false,
  } = options;
  const baseDate = dayjs(date).tz(TZ);
  const baseAmount = Math.floor(amountCents / installmentsTotal);
  const remainder = amountCents - baseAmount * installmentsTotal;
  const amounts = Array.from({ length: installmentsTotal }, (_, index) =>
    index === installmentsTotal - 1 ? baseAmount + remainder : baseAmount,
  );

  const group = await prisma.installmentGroup.create({
    data: {
      userId,
      cardId,
      descriptionBase: description,
      totalAmountCents: amountCents,
      installmentsTotal,
    },
  });

  const expenses = await prisma.$transaction(
    amounts.map((installmentAmount, index) => {
      const installmentDate = buildInstallmentDate(baseDate, index);
      const descriptionSuffix = appendInstallmentLabel
        ? ` (${index + 1}/${installmentsTotal})`
        : '';
      return prisma.expense.create({
        data: {
          userId,
          categoryId,
          cardId,
          paymentMethod,
          amountCents: installmentAmount,
          description: `${description}${descriptionSuffix}`,
          date: installmentDate.toDate(),
          source: options.source ?? DEFAULT_SOURCE,
          rawText,
          installmentGroupId: group.id,
          installmentIndex: index + 1,
          installmentsTotal,
          installmentCurrent: index + 1,
          installmentTotal: installmentsTotal,
          purchaseLabel,
          postedMonth: installmentDate.format('YYYY-MM'),
        },
        include: { category: true, card: { select: CARD_SELECT } },
      });
    }),
  );

  return { groupId: group.id, expenses, amounts };
}
