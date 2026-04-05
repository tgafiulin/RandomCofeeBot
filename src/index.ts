import "dotenv/config";
import { Bot, GrammyError, HttpError } from "grammy";
import { prisma } from "./db/client.js";
import { upsertUserFromTelegram } from "./upsertUser.js";
import { parseAdminTelegramIds } from "./admins.js";
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

const adminTelegramIds = parseAdminTelegramIds();
if (adminTelegramIds.size === 0) {
  console.warn("ADMIN_TELEGRAM_IDS is empty — настройки cron в личке (/settings, /schedule, …) будут недоступны.");
} else {
  console.log(`Admins (user ids): ${[...adminTelegramIds].join(", ")}`);
}

const HELP_TEXT = [
  "Random Coffee — помощь",
  "",
  "В сообществе:",
  "/help — эта памятка",
  "/chatid — id этой группы для ALLOWED_GROUP_IDS в .env",
  "",
  "Расписание и cron — только в личке с ботом:",
  "/settings — выбрать группу",
  "/cron, /schedule, /scheduleoff, /scheduleon, /crontz",
  "",
  "Участники отвечают на опрос в группе кнопками.",
  "Команда /start в личке — кратко о боте.",
].join("\n");

async function trySendAdminDm(userId: number, text: string, api: Bot["api"]): Promise<boolean> {
  try {
    await api.sendMessage(userId, text, { disable_notification: true });
    return true;
  } catch {
    return false;
  }
}

/** Создатель или администратор этого чата (по данным Telegram). */
async function isTelegramChatAdmin(
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

const bot = new Bot(token);

/** Before whitelist: new groups can use /chatid before ALLOWED_GROUP_IDS is updated. */
bot.command("chatid", async (ctx) => {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;

  if (chat.type === "private") {
    if (!adminTelegramIds.has(from.id)) return;
    await ctx.reply(
      "Сейчас это личка: виден только твой user id, не группы.\n\nВ нужной группе отправь /chatid — id группы придёт сюда, в личку (если написал боту /start)."
    );
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const canUse =
    adminTelegramIds.has(from.id) || (await isTelegramChatAdmin(bot.api, chat.id, from.id));
  if (!canUse) return;

  const text = [`ID этой группы: ${chat.id}`, "", `Добавь в .env: ALLOWED_GROUP_IDS=${chat.id}`].join(
    "\n"
  );
  const ok = await trySendAdminDm(from.id, text, bot.api);
  if (!ok) {
    await ctx.reply(
      "Не удалось написать в личку. Напиши боту /start в личке и повтори /chatid — тогда id увидишь только ты."
    );
  }
});

bot.command("help", async (ctx) => {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;

  if (chat.type === "private") {
    if (!adminTelegramIds.has(from.id)) return;
    await ctx.reply(HELP_TEXT);
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const canUse =
    adminTelegramIds.has(from.id) || (await isTelegramChatAdmin(bot.api, chat.id, from.id));
  if (!canUse) return;

  const ok = await trySendAdminDm(from.id, HELP_TEXT, bot.api);
  if (!ok) {
    await ctx.reply(
      "Не удалось написать в личку. Напиши боту /start в личке и повтори /help — тогда памятку увидишь только ты."
    );
  }
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
      ctx.from && adminTelegramIds.has(ctx.from.id)
        ? "\n\nНастройки cron (расписание опроса и пар): /settings — выбери группу, дальше /cron и /schedule."
        : "";
    await ctx.reply(
      `Привет! Я бот Random Coffee. Добавь меня в группу сообщества — там будут опросы и пары на неделю.${extra}`
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
  admins: adminTelegramIds,
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
