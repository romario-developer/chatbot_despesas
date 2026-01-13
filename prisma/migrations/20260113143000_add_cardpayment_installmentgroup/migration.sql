-- Add missing CardPayment table and Expense.installmentGroupId to match schema.prisma
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

ALTER TABLE "Expense" ADD COLUMN "installmentGroupId" TEXT;

CREATE INDEX "Expense_installmentGroupId_idx" ON "Expense"("installmentGroupId");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_installmentGroupId_fkey" FOREIGN KEY ("installmentGroupId") REFERENCES "InstallmentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
