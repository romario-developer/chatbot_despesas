import { prisma } from '../infra/db/prisma';
import { PaymentMethod } from '../utils/paymentMethod';
import { CARD_SELECT } from './cardService';
import {
  splitInstallmentAmounts,
  getInvoiceMonthForPurchase,
  monthStartFromInvoiceMonth,
} from '../utils/installments';

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
  closingDay: number;
};

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
    closingDay,
  } = options;
  const baseInvoiceMonth = getInvoiceMonthForPurchase(date, closingDay);
  const baseMonthDate = monthStartFromInvoiceMonth(baseInvoiceMonth);
  const amounts = splitInstallmentAmounts(amountCents, installmentsTotal);

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
      const installmentMonthDate = baseMonthDate.add(index, 'month');
      const installmentMonth = installmentMonthDate.format('YYYY-MM');
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
          date: installmentMonthDate.toDate(),
          source: options.source ?? 'manual',
          rawText,
          installmentGroupId: group.id,
          installmentIndex: index + 1,
          installmentsTotal,
          installmentCurrent: index + 1,
          installmentTotal: installmentsTotal,
          purchaseLabel,
          postedMonth: installmentMonth,
          invoiceMonth: installmentMonth,
        },
        include: { category: true, card: { select: CARD_SELECT } },
      });
    }),
  );

  return { groupId: group.id, expenses, amounts };
}
