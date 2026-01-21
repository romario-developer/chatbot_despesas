-- Add optional purchase label tracking for expenses.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "purchaseLabel" TEXT;
