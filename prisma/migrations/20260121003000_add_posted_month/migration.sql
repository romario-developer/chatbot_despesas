-- Track posted month for expenses derived from posting date.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "postedMonth" TEXT;
