import "dotenv/config";
import type { Message } from "grammy/types";
import { Bot, GrammyError, HttpError } from "grammy";
import { prisma } from "./db/client.js";
import { upsertUserFromTelegram } from "./upsertUser.js";
import {
  canConfigureGroupAsAdderAndAdmin,
  userCanAccessAnyDmSettings,
} from "./groupChatAuth.js";
import { createPollAnswerHandler } from "./handlers/pollAnswer.js";
import { rescheduleCronJobs, stopCronJobs } from "./scheduler.js";
import { registerCronSettingCommands } from "./commands/cronSettings.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Missing BOT_TOKEN. Copy .env.example to .env and set BOT_TOKEN.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL. Copy .env.example to .env and set DATABASE_URL.");
  process.exit(1);
}

/** `null` = no whitelist (any group allowed). */
function parseAllowedGroupIds(): Set<number> | null {
  const raw = process.env.ALLOWED_GROUP_IDS;
  if (raw === undefined) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return new Set(ids);
}

const allowedGroupIds = parseAllowedGroupIds();

if (allowedGroupIds === null) {
  console.warn(
    "ALLOWED_GROUP_IDS is not set — the bot will respond in any group. Set it in production."
  );
} else if (allowedGroupIds.size === 0) {
  console.warn("ALLOWED_GROUP_IDS is empty — group/supergroup updates will be ignored.");
} else {
  console.log(`Group whitelist active: ${[...allowedGroupIds].join(", ")}`);
}

/** For DM auth: null = env not set (any group); non-null = restrict to these ids (possibly empty). */
function dmAuthWhitelistChatIds(): number[] | null {
  if (allowedGroupIds === null) return null;
  return [...allowedGroupIds];
}

const HELP_TEXT = [
  "Random Coffee — помощь",
  "",
  "В группе: только опросы и результаты.",
  "",
  "В личке (тот, кто добавил бота в группу и сейчас админ/создатель в Telegram):",
  "/help — эта памятка",
  "/settings — выбрать группу",
  "/cron, /schedule, /scheduleoff, /scheduleon, /crontz",
  "",
  "Участники отвечают на опрос в группе кнопками.",
  "/start в личке — кратко о боте.",
].join("\n");

async function trySendAdminDm(userId: number, text: string, api: Bot["api"]): Promise<boolean> {
  try {
    await api.sendMessage(userId, text, { disable_notification: true });
    return true;
  } catch {
    return false;
  }
}

type ForwardedChatRef = { id: number; source: "chat" | "channel" | "sender_chat" };

/**
 * Telegram often sends MessageOriginUser when you forward a **member's** message from a group — there is no chat id then.
 * MessageOriginChat: message sent as the group / anonymous admin; MessageOriginChannel: post from a channel.
 */
function groupChatIdFromForwardedMessage(msg: Message): ForwardedChatRef | undefined {
  const o = msg.forward_origin;
  if (!o) return undefined;

  if (o.type === "chat") {
    const t = o.sender_chat.type;
    if (t === "group" || t === "supergroup") return { id: o.sender_chat.id, source: "chat" };
  }
  if (o.type === "channel") {
    return { id: o.chat.id, source: "channel" };
  }

  if (msg.sender_chat) {
    const t = msg.sender_chat.type;
    if (t === "group" || t === "supergroup") return { id: msg.sender_chat.id, source: "sender_chat" };
    if (t === "channel") return { id: msg.sender_chat.id, source: "sender_chat" };
  }

  return undefined;
}

const bot = new Bot(token);

let cachedBotUserId: number | undefined;

async function getBotUserId(): Promise<number> {
  if (cachedBotUserId === undefined) {
    cachedBotUserId = (await bot.api.getMe()).id;
  }
  return cachedBotUserId;
}

/** До whitelist: id новой группы до добавления в ALLOWED_GROUP_IDS. */
bot.on("my_chat_member", async (ctx) => {
  const upd = ctx.myChatMember;
  if (!upd) return;

  const chat = upd.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const from = upd.from;
  if (!from) return;

  const botId = await getBotUserId();
  const { old_chat_member: oldM, new_chat_member: newM } = upd;

  if (newM.user.id !== botId) return;

  const wasGone = oldM.status === "left" || oldM.status === "kicked";
  const nowPresent =
    newM.status === "member" || newM.status === "administrator" || newM.status === "restricted";
  if (!wasGone || !nowPresent) return;

  await upsertUserFromTelegram(from);

  await prisma.groupChatMeta.upsert({
    where: { telegramChatId: String(chat.id) },
    create: {
      telegramChatId: String(chat.id),
      botAddedByTelegramUserId: BigInt(from.id),
    },
    update: { botAddedByTelegramUserId: BigInt(from.id) },
  });

  const title = "title" in chat && chat.title ? chat.title : "группа";
  const text = [
    `Бот добавлен в «${title}».`,
    "",
    `ID чата:`,
    `${chat.id}`,
    "",
    `ALLOWED_GROUP_IDS=${chat.id}`,
  ].join("\n");

  const ok = await trySendAdminDm(from.id, text, bot.api);
  if (!ok) {
    try {
      await ctx.api.sendMessage(
        chat.id,
        "Не удалось написать в личку. Напиши боту /start в личке, затем удали бота из группы и добавь снова — id чата придёт в личку."
      );
    } catch {
      /* ignore */
    }
  }
});

bot.command("help", async (ctx) => {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;

  if (chat.type !== "private") return;

  if (!(await userCanAccessAnyDmSettings(bot.api, from.id, dmAuthWhitelistChatIds()))) return;

  await ctx.reply(HELP_TEXT);
});

bot.on("message:forward_origin").use(async (ctx, next) => {
  if (ctx.chat?.type !== "private" || !ctx.from || !ctx.message) {
    return next();
  }

  const ref = groupChatIdFromForwardedMessage(ctx.message);
  if (ref === undefined) {
    const o = ctx.message.forward_origin;
    if (o?.type === "user" || o?.type === "hidden_user") {
      await ctx.reply(
        [
          "Id группы неизвестен: Telegram при пересылке сообщения участника не передаёт id чата.",
          "",
          "Надёжно: напиши боту /start в личке, удали бота из группы и добавь снова — id чата придёт в личку тому, кто добавит.",
          "",
          "Иначе переслать сообщение от имени группы или пост из канала; либо проверить настройки приватности пересылки.",
        ].join("\n")
      );
      return;
    }
    return next();
  }

  const { id: groupId, source } = ref;

  const canUse = await canConfigureGroupAsAdderAndAdmin(bot.api, groupId, ctx.from.id);
  if (!canUse) {
    return next();
  }

  const channelNote =
    source === "channel" || source === "sender_chat"
      ? "\n\nЕсли у вас связка «канал + группа обсуждений», для ALLOWED_GROUP_IDS обычно нужен id супергруппы обсуждений (он может отличаться от id канала)."
      : "";

  const text = [
    `ID этого чата: ${groupId}`,
    "",
    `Добавь в .env: ALLOWED_GROUP_IDS=${groupId}`,
    channelNote,
  ].join("\n");
  await ctx.reply(text);
});

if (allowedGroupIds !== null) {
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (chat?.type === "group" || chat?.type === "supergroup") {
      if (!allowedGroupIds.has(chat.id)) {
        return;
      }
    }
    await next();
  });
}

bot.command("start", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;

  if (ctx.from) {
    await upsertUserFromTelegram(ctx.from);
  }

  if (chat.type === "private") {
    const extra =
      ctx.from && (await userCanAccessAnyDmSettings(bot.api, ctx.from.id, dmAuthWhitelistChatIds()))
        ? "\n\nНастройки cron (расписание опроса и пар): /settings — выбери группу, дальше /cron и /schedule."
        : "";
    await ctx.reply(
      `Привет! Я бот Random Coffee. Добавь меня в группу сообщества — там будут опросы и пары на неделю. После этого в личку придёт id чата для настройки (ALLOWED_GROUP_IDS).${extra}`
    );
    return;
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    return;
  }

  await ctx.reply("Random Coffee бот готов к работе.");
});

const cronChatIds =
  allowedGroupIds === null || allowedGroupIds.size === 0 ? [] : [...allowedGroupIds];

async function resyncCron(): Promise<void> {
  await rescheduleCronJobs(bot.api, cronChatIds);
}

bot.on("callback_query").use(async (ctx, next) => {
  if (ctx.chat?.type !== "private") {
    await ctx.answerCallbackQuery();
    return;
  }
  await next();
});

registerCronSettingCommands(bot, {
  api: bot.api,
  canConfigureGroup: (userId, groupChatId) =>
    canConfigureGroupAsAdderAndAdmin(bot.api, groupChatId, userId),
  whitelistChatIds: cronChatIds,
  reschedule: resyncCron,
});

bot.on("poll_answer", createPollAnswerHandler(allowedGroupIds));

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Telegram error:", e.description);
  } else if (e instanceof HttpError) {
    console.error("HTTP error:", e);
  } else {
    console.error("Unknown error:", e);
  }
});

async function shutdown(signal: string) {
  console.log(`\n${signal} received, stopping…`);
  stopCronJobs();
  await bot.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await prisma.$connect();
console.log("Database connected");

await resyncCron();

await bot.start({
  onStart: (me) => console.log(`Bot @${me.username} is running (long polling)`),
});
