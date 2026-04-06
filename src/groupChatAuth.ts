import type { Bot } from "grammy";
import { prisma } from "./db/client.js";

/** Telegram creator or administrator of the chat. */
export async function isTelegramChatAdmin(
  api: Bot["api"],
  chatId: number,
  userId: number
): Promise<boolean> {
  try {
    const m = await api.getChatMember(chatId, userId);
    return m.status === "creator" || m.status === "administrator";
  } catch {
    return false;
  }
}

export async function getBotAddedByUserId(telegramChatId: number): Promise<number | null> {
  const row = await prisma.groupChatMeta.findUnique({
    where: { telegramChatId: String(telegramChatId) },
    select: { botAddedByTelegramUserId: true },
  });
  if (!row) return null;
  return Number(row.botAddedByTelegramUserId);
}

/**
 * DM settings only if the user is both the stored adder and currently admin/creator in Telegram.
 */
export async function canConfigureGroupAsAdderAndAdmin(
  api: Bot["api"],
  groupChatId: number,
  userId: number
): Promise<boolean> {
  const addedBy = await getBotAddedByUserId(groupChatId);
  if (addedBy == null || addedBy !== userId) return false;
  return isTelegramChatAdmin(api, groupChatId, userId);
}

/**
 * For /help and /start: user may use DM admin flows for at least one chat.
 * Non-empty `whitelistChatIds` restricts which chats count (from ALLOWED_GROUP_IDS).
 * When null/empty env list, any known GroupChatMeta row is checked.
 */
export async function userCanAccessAnyDmSettings(
  api: Bot["api"],
  userId: number,
  whitelistChatIds: number[] | null
): Promise<boolean> {
  if (whitelistChatIds && whitelistChatIds.length > 0) {
    for (const id of whitelistChatIds) {
      if (await canConfigureGroupAsAdderAndAdmin(api, id, userId)) return true;
    }
    return false;
  }

  const metas = await prisma.groupChatMeta.findMany({ select: { telegramChatId: true } });
  for (const m of metas) {
    const id = Number(m.telegramChatId);
    if (!Number.isFinite(id)) continue;
    if (await canConfigureGroupAsAdderAndAdmin(api, id, userId)) return true;
  }
  return false;
}
