-- Add missing installment tracking columns to Expense.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installmentCurrent" INTEGER;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installmentTotal" INTEGER;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installmentGroupId" TEXT;
