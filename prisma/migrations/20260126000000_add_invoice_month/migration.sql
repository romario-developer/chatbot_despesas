-- Add invoiceMonth column to Expense
ALTER TABLE "Expense"
  ADD COLUMN "invoiceMonth" TEXT;

CREATE INDEX IF NOT EXISTS "Expense_userId_invoiceMonth_idx"
  ON "Expense" ("userId", "invoiceMonth");
CREATE INDEX IF NOT EXISTS "Expense_cardId_invoiceMonth_idx"
  ON "Expense" ("cardId", "invoiceMonth");
CREATE INDEX IF NOT EXISTS "Expense_userId_cardId_invoiceMonth_idx"
  ON "Expense" ("userId", "cardId", "invoiceMonth");
