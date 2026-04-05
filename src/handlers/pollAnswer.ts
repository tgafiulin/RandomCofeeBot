import type { Context } from "grammy";
import { prisma } from "../db/client.js";
import { choiceFromOptionIds } from "../poll.js";
import { upsertUserFromTelegram } from "../upsertUser.js";

export function createPollAnswerHandler(allowedGroupIds: Set<number> | null) {
  return async (ctx: Context): Promise<void> => {
    const pa = ctx.pollAnswer;
    if (!pa) return;

    const round = await prisma.round.findFirst({
      where: { telegramPollId: pa.poll_id, status: "POLL_OPEN" },
    });
    if (!round) return;

    if (allowedGroupIds !== null && !allowedGroupIds.has(Number(round.telegramChatId))) {
      return;
    }

    const tgUser = pa.user;
    if (!tgUser) return;

    await upsertUserFromTelegram(tgUser);
    const user = await prisma.user.findUnique({
      where: { telegramUserId: BigInt(tgUser.id) },
    });
    if (!user) return;

    if (pa.option_ids.length === 0) {
      await prisma.roundParticipation.deleteMany({
        where: { roundId: round.id, userId: user.id },
      });
      return;
    }

    const choice = choiceFromOptionIds(pa.option_ids);
    if (choice === null) return;

    await prisma.roundParticipation.upsert({
      where: {
        roundId_userId: { roundId: round.id, userId: user.id },
      },
      create: { roundId: round.id, userId: user.id, choice },
      update: { choice },
    });
  };
}
