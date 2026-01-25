-- Create the AssistantConversation table needed by the Prisma schema.
CREATE TABLE "AssistantConversation" (
    "conversationId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "pendingDraft" JSONB,
    "pendingQuestion" TEXT NOT NULL DEFAULT 'none',
    "lastExpenseId" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("conversationId")
);

-- CreateIndex
CREATE INDEX "AssistantConversation_userId_idx" ON "AssistantConversation"("userId");

-- AddForeignKey
ALTER TABLE "AssistantConversation" ADD CONSTRAINT "AssistantConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
