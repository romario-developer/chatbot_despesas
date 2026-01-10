-- Add payment method and optional card link to Expense
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'DEBIT', 'CREDIT', 'PIX', 'TRANSFER', 'OTHER');

ALTER TABLE "Expense" ADD COLUMN "cardId" INTEGER;
ALTER TABLE "Expense" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'OTHER';

CREATE INDEX "Expense_cardId_idx" ON "Expense"("cardId");
CREATE INDEX "Expense_date_idx" ON "Expense"("date");
CREATE INDEX "Expense_userId_month_idx" ON "Expense"("userId", date_trunc('month', "date"));

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExpenseDraft" ADD COLUMN "cardId" INTEGER;
ALTER TABLE "ExpenseDraft" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'OTHER';

CREATE INDEX "ExpenseDraft_cardId_idx" ON "ExpenseDraft"("cardId");

ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "ExpenseDraft_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;
