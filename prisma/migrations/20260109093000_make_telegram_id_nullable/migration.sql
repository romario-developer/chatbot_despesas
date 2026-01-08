-- Allow null telegramId for unlinking
ALTER TABLE "User" ALTER COLUMN "telegramId" DROP NOT NULL;
