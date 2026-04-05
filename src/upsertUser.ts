import type { User as TgUser } from "grammy/types";
import { prisma } from "./db/client.js";

export async function upsertUserFromTelegram(from: TgUser): Promise<void> {
  await prisma.user.upsert({
    where: { telegramUserId: BigInt(from.id) },
    create: {
      telegramUserId: BigInt(from.id),
      username: from.username ?? null,
      firstName: from.first_name,
      lastName: from.last_name ?? null,
    },
    update: {
      username: from.username ?? null,
      firstName: from.first_name,
      lastName: from.last_name ?? null,
    },
  });
}
