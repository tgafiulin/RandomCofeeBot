-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramUserId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "dmCronTargetChatId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramChatId" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POLL_OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchedAt" DATETIME,
    "pollMessageId" BIGINT,
    "telegramPollId" TEXT
);

-- CreateTable
CREATE TABLE "RoundParticipation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "choice" TEXT NOT NULL,
    CONSTRAINT "RoundParticipation_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoundParticipation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupCronSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramChatId" TEXT NOT NULL,
    "cronDisabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT,
    "pollWeekday" INTEGER,
    "pollHour" INTEGER,
    "pollMinute" INTEGER NOT NULL DEFAULT 0,
    "matchWeekday" INTEGER,
    "matchHour" INTEGER,
    "matchMinute" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GroupChatMeta" (
    "telegramChatId" TEXT NOT NULL PRIMARY KEY,
    "botAddedByTelegramUserId" BIGINT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Round_telegramPollId_key" ON "Round"("telegramPollId");

-- CreateIndex
CREATE INDEX "Round_telegramChatId_idx" ON "Round"("telegramChatId");

-- CreateIndex
CREATE INDEX "Round_telegramChatId_status_idx" ON "Round"("telegramChatId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RoundParticipation_roundId_userId_key" ON "RoundParticipation"("roundId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupCronSettings_telegramChatId_key" ON "GroupCronSettings"("telegramChatId");
