-- Migration: Add installment tracking columns on Expense
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installmentCurrent" INTEGER;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installmentTotal" INTEGER;
