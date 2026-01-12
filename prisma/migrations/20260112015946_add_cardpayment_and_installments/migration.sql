-- CreateIndex
CREATE INDEX "Expense_userId_date_idx" ON "Expense"("userId", "date");

-- RenameIndex
ALTER INDEX "CardPayment_user_card_cycle_idx" RENAME TO "CardPayment_userId_cardId_cycleEnd_idx";

-- RenameIndex
ALTER INDEX "Expense_user_card_date_idx" RENAME TO "Expense_userId_cardId_date_idx";

-- RenameIndex
ALTER INDEX "InstallmentGroup_user_card_idx" RENAME TO "InstallmentGroup_userId_cardId_idx";
