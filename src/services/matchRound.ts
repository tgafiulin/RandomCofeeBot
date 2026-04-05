import type { User } from "@prisma/client";
import type { Api } from "grammy";
import { prisma } from "../db/client.js";

function formatUserMention(user: User): string {
  if (user.username) {
    return `@${user.username}`;
  }
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || "участник";
}

function shuffleInPlace<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

export type MatchRoundResult =
  | { ok: true }
  | { ok: false; reason: "no_round" | "no_participants" | "send_failed"; detail?: string };

async function resolveGroupTitle(api: Api, chatId: number): Promise<string> {
  try {
    const chat = await api.getChat(chatId);
    if (
      chat &&
      (chat.type === "group" || chat.type === "supergroup") &&
      "title" in chat &&
      chat.title
    ) {
      return chat.title;
    }
  } catch {
    // keep fallback
  }
  return "группы";
}

export async function runMatchRound(api: Api, chatId: number): Promise<MatchRoundResult> {
  const telegramChatId = BigInt(chatId);

  const round = await prisma.round.findFirst({
    where: { telegramChatId, status: "POLL_OPEN" },
  });
  if (!round) {
    return { ok: false, reason: "no_round" };
  }

  const rows = await prisma.roundParticipation.findMany({
    where: { roundId: round.id, choice: "PARTICIPATE" },
    include: { user: true },
  });

  if (rows.length === 0) {
    return { ok: false, reason: "no_participants" };
  }

  const users = rows.map((r) => r.user);
  shuffleInPlace(users);

  const pairLines: string[] = [];
  let solo: User | null = null;

  for (let i = 0; i < users.length; i += 2) {
    const a = users[i];
    const b = users[i + 1];
    if (b) {
      pairLines.push(`➪ ${formatUserMention(a)} x ${formatUserMention(b)}`);
    } else {
      solo = a;
    }
  }

  const title = await resolveGroupTitle(api, chatId);
  const lines: string[] = [];

  lines.push(`Пары для ${title} составлены!`);

  if (pairLines.length > 0) {
    lines.push("");
    lines.push("Ищи в списке ниже, с кем встречаешься на этой неделю:");
    lines.push(...pairLines);
    lines.push("");
    lines.push(
      "Напиши собеседнику в личку, чтобы договориться об удобном времени и формате встречи ☕️"
    );
  }

  if (solo) {
    if (pairLines.length === 0) {
      lines.push("");
      lines.push("Голосов «Участвую» только один — пары не сформированы.");
    }
    lines.push("");
    lines.push("Не хватило пары:");
    lines.push(`➪ ${formatUserMention(solo)}`);
    lines.push(
      "Напиши ему/ей, если не успел(а) отметиться, и хочешь встречу на этой неделе."
    );
  }

  const text = lines.join("\n");

  try {
    await api.sendMessage(chatId, text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`runMatchRound sendMessage chat ${chatId}:`, err);
    return { ok: false, reason: "send_failed", detail };
  }

  await prisma.round.update({
    where: { id: round.id },
    data: { status: "MATCHED", matchedAt: new Date() },
  });

  return { ok: true };
}
