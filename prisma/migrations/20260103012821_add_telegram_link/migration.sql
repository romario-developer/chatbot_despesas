
-- Add telegram chat link to users
ALTER TABLE "User" ADD COLUMN "telegramChatId" TEXT;

CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- Link codes for Telegram pairing
CREATE TABLE "TelegramLinkCode" (
    "code" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "TelegramLinkCode_expiresAt_idx" ON "TelegramLinkCode"("expiresAt");

ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
