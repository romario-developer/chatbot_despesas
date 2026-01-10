-- Add payment method and optional card link to Expense
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'DEBIT', 'CREDIT', 'PIX', 'TRANSFER', 'OTHER');

ALTER TABLE "Expense" ADD COLUMN "cardId" INTEGER;
ALTER TABLE "Expense" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'OTHER';

CREATE INDEX "Expense_cardId_idx" ON "Expense"("cardId");
CREATE INDEX "Expense_date_idx" ON "Expense"("date");
CREATE INDEX "Expense_userId_month_idx" ON "Expense"("userId", date_trunc('month', "date"));
CREATE INDEX "Expense_user_card_date_idx" ON "Expense"("userId", "cardId", "date");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "InstallmentGroup" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "cardId" INTEGER NOT NULL,
    "descriptionBase" TEXT NOT NULL,
    "totalAmountCents" INTEGER NOT NULL,
    "installmentsTotal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstallmentGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InstallmentGroup_user_card_idx" ON "InstallmentGroup"("userId", "cardId");

ALTER TABLE "InstallmentGroup" ADD CONSTRAINT "InstallmentGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstallmentGroup" ADD CONSTRAINT "InstallmentGroup_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Expense" ADD COLUMN "installmentGroupId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "installmentIndex" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Expense" ADD COLUMN "installmentsTotal" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "Expense_installmentGroupId_idx" ON "Expense"("installmentGroupId");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_installmentGroupId_fkey" FOREIGN KEY ("installmentGroupId") REFERENCES "InstallmentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CardPayment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "cardId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "cycleEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CardPayment_user_card_cycle_idx" ON "CardPayment"("userId", "cardId", "cycleEnd");

ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExpenseDraft" ADD COLUMN "cardId" INTEGER;
ALTER TABLE "ExpenseDraft" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'OTHER';

CREATE INDEX "ExpenseDraft_cardId_idx" ON "ExpenseDraft"("cardId");

ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "ExpenseDraft_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;
