-- Add stage column to AssistantConversation
ALTER TABLE "AssistantConversation"
  ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'idle';
