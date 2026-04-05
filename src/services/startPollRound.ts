import type { Api } from "grammy";
import { prisma } from "../db/client.js";
import { POLL_OPTIONS, POLL_QUESTION } from "../poll.js";

export type StartPollResult =
  | { ok: true }
  | { ok: false; reason: "existing_open" | "telegram_error" | "db_error"; detail?: string };

export async function startPollRound(api: Api, chatId: number): Promise<StartPollResult> {
  const telegramChatId = BigInt(chatId);

  const existing = await prisma.round.findFirst({
    where: { telegramChatId, status: "POLL_OPEN" },
  });
  if (existing) {
    return { ok: false, reason: "existing_open" };
  }

  let pollMessageId: number | undefined;
  try {
    const message = await api.sendPoll(chatId, POLL_QUESTION, [...POLL_OPTIONS], {
      is_anonymous: false,
      allows_multiple_answers: false,
    });

    pollMessageId = message.message_id;
    const poll = message.poll;
    if (!poll) {
      await api.deleteMessage(chatId, message.message_id).catch(() => {});
      return { ok: false, reason: "telegram_error", detail: "no poll in response" };
    }

    await prisma.round.create({
      data: {
        telegramChatId,
        status: "POLL_OPEN",
        pollMessageId: BigInt(message.message_id),
        telegramPollId: poll.id,
      },
    });

    return { ok: true };
  } catch (err) {
    if (pollMessageId !== undefined) {
      await api.deleteMessage(chatId, pollMessageId).catch(() => {});
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`startPollRound chat ${chatId}:`, err);
    return { ok: false, reason: "telegram_error", detail };
  }
}
