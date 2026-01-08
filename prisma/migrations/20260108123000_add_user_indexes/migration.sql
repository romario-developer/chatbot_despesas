-- Add per-user lookup indexes
CREATE INDEX "Category_userId_createdAt_idx" ON "Category"("userId", "createdAt");
CREATE INDEX "Expense_userId_createdAt_idx" ON "Expense"("userId", "createdAt");
