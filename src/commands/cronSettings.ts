import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "../db/client.js";
import {
  formatWeekdayRu,
  isValidIanaTimezone,
  parseClock,
  toWeeklyCronExpression,
} from "../scheduleParse.js";
import {
  clearScheduleDraft,
  clearScheduleDraftsForUser,
  getScheduleDraft,
  hasScheduleDraftForUser,
  setScheduleDraft,
} from "../scheduleDraft.js";
import { upsertUserFromTelegram } from "../upsertUser.js";
import { DEFAULT_CRON_TIMEZONE } from "../cronConstants.js";

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

type Deps = {
  api: Bot["api"];
  canConfigureGroup: (userId: number, groupChatId: number) => Promise<boolean>;
  whitelistChatIds: number[];
  reschedule: () => Promise<void>;
};

function assertPrivateChat(ctx: Context): ctx is Context & { chat: { type: "private" }; from: NonNullable<Context["from"]> } {
  const chat = ctx.chat;
  const from = ctx.from;
  return !!(chat && chat.type === "private" && from);
}

const NO_ACCESS =
  "Нет доступа к настройкам этой группы: нужно быть администратором или создателем и тем пользователем, который добавил бота в чат.";

function tailAfterCommand(text: string): string {
  const trimmed = text.trim();
  const i = trimmed.indexOf(" ");
  if (i === -1) return "";
  return trimmed.slice(i + 1).trim();
}

async function getDmTargetChatIdString(userId: number): Promise<string | null> {
  const row = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(userId) },
    select: { dmCronTargetChatId: true },
  });
  const s = row?.dmCronTargetChatId?.trim();
  return s && s.length > 0 ? s : null;
}

/** Resolves selected group for DM admin flows; replies on error. */
async function resolveDmTargetGroupId(
  ctx: Context,
  whitelistChatIds: number[]
): Promise<number | null> {
  const from = ctx.from;
  if (!from) return null;

  if (whitelistChatIds.length === 0) {
    await ctx.reply("Нужен ALLOWED_GROUP_IDS в .env — без него не к чему привязать расписание.");
    return null;
  }

  const raw = await getDmTargetChatIdString(from.id);
  if (!raw) {
    await ctx.reply("Сначала выбери группу: /settings");
    return null;
  }

  const id = Number(raw);
  if (!Number.isFinite(id) || !whitelistChatIds.includes(id)) {
    await ctx.reply("Сохранённая группа больше не в whitelist. Выбери снова: /settings");
    return null;
  }

  return id;
}

async function groupTitle(api: Bot["api"], chatId: number): Promise<string> {
  try {
    const ch = await api.getChat(chatId);
    if (ch.type === "group" || ch.type === "supergroup") {
      return "title" in ch && ch.title ? ch.title : `Чат ${chatId}`;
    }
  } catch {
    /* ignore */
  }
  return `Чат ${chatId}`;
}

function scheduleRootKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Опрос", "sch:p")
    .text("Матчинг", "sch:m")
    .row()
    .text("Отмена", "sch:x");
}

function weekdayKeyboard(prefix: "p" | "m"): InlineKeyboard {
  const kb = new InlineKeyboard();
  const row1 = [
    { d: 1, l: "пн" },
    { d: 2, l: "вт" },
    { d: 3, l: "ср" },
    { d: 4, l: "чт" },
  ];
  for (const x of row1) {
    kb.text(x.l, `${prefix}:d:${x.d}`);
  }
  kb.row();
  const row2 = [
    { d: 5, l: "пт" },
    { d: 6, l: "сб" },
    { d: 0, l: "вс" },
  ];
  for (const x of row2) {
    kb.text(x.l, `${prefix}:d:${x.d}`);
  }
  kb.row().text("« Назад", "sch:menu");
  return kb;
}

export function registerCronSettingCommands(bot: Bot, deps: Deps): void {
  const { api, canConfigureGroup, whitelistChatIds, reschedule } = deps;

  bot.command("settings", async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const from = ctx.from;
    await upsertUserFromTelegram(from);

    if (whitelistChatIds.length === 0) {
      await ctx.reply(
        "В .env задай ALLOWED_GROUP_IDS (id чата приходит в личку при добавлении бота в группу после /start; либо пересылка от имени группы/канала). После перезапуска бота открой /settings снова."
      );
      return;
    }

    const allowedForUser: number[] = [];
    for (const id of whitelistChatIds) {
      if (await canConfigureGroup(from.id, id)) allowedForUser.push(id);
    }

    if (allowedForUser.length === 0) {
      await ctx.reply(
        "Нет доступных групп: для каждой группы в списке нужно быть администратором или создателем и тем, кто добавил бота в этот чат. Если бот был добавлен до этой логики — удали бота из группы и добавь снова."
      );
      return;
    }

    const lines: string[] = ["Группа для настроек расписания (cron):"];
    const current = await getDmTargetChatIdString(from.id);
    if (current) {
      const id = Number(current);
      if (Number.isFinite(id) && allowedForUser.includes(id)) {
        const title = await groupTitle(api, id);
        lines.push("", `Сейчас: ${title}`, `id: ${id}`);
      } else {
        lines.push("", "Сохранённый чат недоступен — выбери заново.");
      }
    } else {
      lines.push("", "Пока не выбрана — нажми кнопку ниже.");
    }

    const kb = new InlineKeyboard();
    for (const id of allowedForUser) {
      const title = await groupTitle(api, id);
      const label = title.length > 48 ? `${title.slice(0, 45)}…` : title;
      kb.text(label, `setgrp:${id}`).row();
    }

    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  });

  bot.callbackQuery(/^setgrp:(-?\d+)$/, async (ctx) => {
    if (!ctx.from || ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery();
      return;
    }
    const from = ctx.from;
    const id = Number(ctx.match![1]);
    if (!whitelistChatIds.includes(id)) {
      await ctx.answerCallbackQuery({ text: "Этот чат не в ALLOWED_GROUP_IDS.", show_alert: true });
      return;
    }
    if (!(await canConfigureGroup(from.id, id))) {
      await ctx.answerCallbackQuery({ text: NO_ACCESS, show_alert: true });
      return;
    }

    await upsertUserFromTelegram(from);
    await prisma.user.update({
      where: { telegramUserId: BigInt(from.id) },
      data: { dmCronTargetChatId: String(id) },
    });
    clearScheduleDraftsForUser(from.id);

    const title = await groupTitle(api, id);
    await ctx.answerCallbackQuery({ text: "Сохранено" });
    try {
      await ctx.editMessageText(
        `Выбрана группа: ${title}\n(id ${id})\n\nДальше в личке: /cron — сводка, /schedule — время опроса и матчинга, /crontz, /scheduleoff, /scheduleon.`
      );
    } catch {
      await ctx.reply(
        `Выбрана группа: ${title}\n(id ${id})\n\n/cron, /schedule, /crontz, /scheduleoff, /scheduleon — в этой личке.`
      );
    }
  });

  bot.command("cron", async (ctx) => {
    if (!assertPrivateChat(ctx)) return;

    if (whitelistChatIds.length === 0) {
      await ctx.reply(
        [
          "ALLOWED_GROUP_IDS в .env не задан или пустой.",
          "",
          `Пояс cron по умолчанию (если у группы нет /crontz): ${DEFAULT_CRON_TIMEZONE} — константа в коде src/cronConstants.ts.`,
        ].join("\n")
      );
      return;
    }

    const targetId = await resolveDmTargetGroupId(ctx, whitelistChatIds);
    if (targetId == null) return;

    if (!(await canConfigureGroup(ctx.from.id, targetId))) {
      await ctx.reply(NO_ACCESS);
      return;
    }

    const row = await prisma.groupCronSettings.findUnique({
      where: { telegramChatId: String(targetId) },
    });

    const title = await groupTitle(api, targetId);

    const autoLine = row?.cronDisabled
      ? "Автоопрос и авто-матчинг: выключены (/scheduleon — включить снова)."
      : "Автоопрос и авто-матчинг: включены (/scheduleoff — выключить).";

    const tzLine = row?.timezone?.trim()
      ? `Часовой пояс (переопределение группы /crontz): ${row.timezone}`
      : `Часовой пояс для cron: по умолчанию ${DEFAULT_CRON_TIMEZONE} (константа в коде). Свой пояс для этой группы: /crontz`;

    let pollLine: string;
    if (row?.pollWeekday != null && row?.pollHour != null) {
      const m = row.pollMinute ?? 0;
      pollLine = `Опрос: ${formatWeekdayRu(row.pollWeekday)} ${pad2(row.pollHour)}:${pad2(m)}`;
    } else {
      pollLine = "Опрос: не задан. Настрой: /schedule";
    }

    let matchLine: string;
    if (row?.matchWeekday != null && row?.matchHour != null) {
      const m = row.matchMinute ?? 0;
      matchLine = `Матчинг: ${formatWeekdayRu(row.matchWeekday)} ${pad2(row.matchHour)}:${pad2(m)}`;
    } else {
      matchLine = "Матчинг: не задан. Настрой: /schedule";
    }

    await ctx.reply(
      [
        `Группа: ${title} (${targetId})`,
        "",
        "Настройки расписания:",
        "",
        autoLine,
        "",
        tzLine,
        "",
        pollLine,
        "",
        matchLine,
      ].join("\n")
    );
  });

  bot.command("schedule", async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const targetId = await resolveDmTargetGroupId(ctx, whitelistChatIds);
    if (targetId == null) return;
    if (!(await canConfigureGroup(ctx.from.id, targetId))) {
      await ctx.reply(NO_ACCESS);
      return;
    }

    clearScheduleDraft(targetId, ctx.from.id);
    await ctx.reply("Что настраиваем?", { reply_markup: scheduleRootKeyboard() });
  });

  /** Resolves target + auth; `null` if failed (replies / answers callback as needed). */
  async function assertScheduleCallback(ctx: Context): Promise<number | null> {
    if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
      await ctx.answerCallbackQuery();
      return null;
    }
    if (!ctx.from) {
      await ctx.answerCallbackQuery();
      return null;
    }
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery();
      return null;
    }
    const targetId = await resolveDmTargetGroupId(ctx, whitelistChatIds);
    if (targetId == null) {
      await ctx.answerCallbackQuery();
      return null;
    }
    if (!(await canConfigureGroup(ctx.from.id, targetId))) {
      await ctx.answerCallbackQuery({ text: NO_ACCESS, show_alert: true });
      return null;
    }
    return targetId;
  }

  bot.callbackQuery("sch:menu", async (ctx) => {
    const targetId = await assertScheduleCallback(ctx);
    if (targetId == null) return;
    clearScheduleDraft(targetId, ctx.from!.id);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("Что настраиваем?", { reply_markup: scheduleRootKeyboard() });
    } catch {
      await ctx.reply("Что настраиваем?", { reply_markup: scheduleRootKeyboard() });
    }
  });

  bot.callbackQuery("sch:x", async (ctx) => {
    const targetId = await assertScheduleCallback(ctx);
    if (targetId == null) return;
    const from = ctx.from!;
    clearScheduleDraft(targetId, from.id);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("Отменено.");
    } catch {
      await ctx.reply("Отменено.");
    }
  });

  bot.callbackQuery("sch:p", async (ctx) => {
    const targetId = await assertScheduleCallback(ctx);
    if (targetId == null) return;
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("День недели для опроса:", { reply_markup: weekdayKeyboard("p") });
    } catch {
      await ctx.reply("День недели для опроса:", { reply_markup: weekdayKeyboard("p") });
    }
  });

  bot.callbackQuery("sch:m", async (ctx) => {
    const targetId = await assertScheduleCallback(ctx);
    if (targetId == null) return;
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("День недели для матчинга:", { reply_markup: weekdayKeyboard("m") });
    } catch {
      await ctx.reply("День недели для матчинга:", { reply_markup: weekdayKeyboard("m") });
    }
  });

  bot.callbackQuery(/^p:d:([0-6])$/, async (ctx) => {
    const targetId = await assertScheduleCallback(ctx);
    if (targetId == null) return;
    const weekday = Number(ctx.match![1]);
    setScheduleDraft({
      kind: "poll",
      weekday,
      chatId: targetId,
      userId: ctx.from!.id,
    });
    await ctx.answerCallbackQuery();
    const label = formatWeekdayRu(weekday);
    try {
      await ctx.editMessageText(
        `Выбран день: ${label}.\n\nНапиши в этот чат время в формате чч:мм (например 20:00).`,
        { reply_markup: new InlineKeyboard() }
      );
    } catch {
      await ctx.reply(
        `Выбран день: ${label}.\n\nНапиши в этот чат время в формате чч:мм (например 20:00).`
      );
    }
  });

  bot.callbackQuery(/^m:d:([0-6])$/, async (ctx) => {
    const targetId = await assertScheduleCallback(ctx);
    if (targetId == null) return;
    const weekday = Number(ctx.match![1]);
    setScheduleDraft({
      kind: "match",
      weekday,
      chatId: targetId,
      userId: ctx.from!.id,
    });
    await ctx.answerCallbackQuery();
    const label = formatWeekdayRu(weekday);
    try {
      await ctx.editMessageText(
        `Выбран день: ${label}.\n\nНапиши в этот чат время в формате чч:мм (например 10:00).`,
        { reply_markup: new InlineKeyboard() }
      );
    } catch {
      await ctx.reply(
        `Выбран день: ${label}.\n\nНапиши в этот чат время в формате чч:мм (например 10:00).`
      );
    }
  });

  bot.command("crontz", async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const targetId = await resolveDmTargetGroupId(ctx, whitelistChatIds);
    if (targetId == null) return;
    if (!(await canConfigureGroup(ctx.from.id, targetId))) {
      await ctx.reply(NO_ACCESS);
      return;
    }

    const tzRaw = tailAfterCommand(ctx.message?.text ?? "");
    if (!tzRaw) {
      await ctx.reply("Пример: /crontz Europe/Minsk");
      return;
    }
    if (!isValidIanaTimezone(tzRaw)) {
      await ctx.reply("Похоже на неверный часовой пояс. Пример: Europe/Minsk, UTC.");
      return;
    }

    await prisma.groupCronSettings.upsert({
      where: { telegramChatId: String(targetId) },
      create: {
        telegramChatId: String(targetId),
        timezone: tzRaw,
      },
      update: { timezone: tzRaw },
    });

    await ctx.reply(`Часовой пояс для этой группы: ${tzRaw}. Перезапускаю cron…`);
    await reschedule();
  });

  bot.command("scheduleoff", async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const targetId = await resolveDmTargetGroupId(ctx, whitelistChatIds);
    if (targetId == null) return;
    if (!(await canConfigureGroup(ctx.from.id, targetId))) {
      await ctx.reply(NO_ACCESS);
      return;
    }

    await prisma.groupCronSettings.upsert({
      where: { telegramChatId: String(targetId) },
      create: { telegramChatId: String(targetId), cronDisabled: true },
      update: { cronDisabled: true },
    });

    await ctx.reply(
      "Авто-опрос и авто-матчинг для этой группы выключены (в т.ч. из .env для этого чата). Перезапускаю cron…"
    );
    await reschedule();
  });

  bot.command("scheduleon", async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const targetId = await resolveDmTargetGroupId(ctx, whitelistChatIds);
    if (targetId == null) return;
    if (!(await canConfigureGroup(ctx.from.id, targetId))) {
      await ctx.reply(NO_ACCESS);
      return;
    }

    await prisma.groupCronSettings.upsert({
      where: { telegramChatId: String(targetId) },
      create: { telegramChatId: String(targetId), cronDisabled: false },
      update: { cronDisabled: false },
    });

    await ctx.reply("Авто-опрос и авто-матчинг снова включены (если задано расписание). Перезапускаю cron…");
    await reschedule();
  });

  bot
    .on("message:text")
    .filter((ctx) => {
      const chat = ctx.chat;
      const from = ctx.from;
      if (!chat || chat.type !== "private") return false;
      if (!from) return false;
      const t = ctx.message.text.trim();
      if (t.startsWith("/")) return false;
      return hasScheduleDraftForUser(from.id);
    })
    .use(async (ctx) => {
      const from = ctx.from!;
      const rawTarget = await getDmTargetChatIdString(from.id);
      const targetId =
        rawTarget && whitelistChatIds.includes(Number(rawTarget)) ? Number(rawTarget) : null;
      if (targetId == null) {
        await ctx.reply("Сначала выбери группу: /settings");
        return;
      }

      if (!(await canConfigureGroup(from.id, targetId))) {
        await ctx.reply(NO_ACCESS);
        return;
      }

      const draft = getScheduleDraft(targetId, from.id);
      if (!draft) {
        await ctx.reply("Черновик расписания устарел. Начни снова: /schedule");
        return;
      }

      const time = parseClock(ctx.message.text);
      if (!time) {
        await ctx.reply("Нужен формат чч:мм, например 09:30 или 20:00.");
        return;
      }

      clearScheduleDraft(targetId, from.id);

      if (draft.kind === "poll") {
        const row = await prisma.groupCronSettings.upsert({
          where: { telegramChatId: String(targetId) },
          create: {
            telegramChatId: String(targetId),
            pollWeekday: draft.weekday,
            pollHour: time.hour,
            pollMinute: time.minute,
          },
          update: {
            pollWeekday: draft.weekday,
            pollHour: time.hour,
            pollMinute: time.minute,
          },
        });
        const tzNote = row.timezone?.trim() || DEFAULT_CRON_TIMEZONE;
        await ctx.reply(
          `Опрос: каждый ${formatWeekdayRu(draft.weekday)} в ${pad2(time.hour)}:${pad2(time.minute)}. Пояс: ${tzNote}. Cron обновлён.`
        );
      } else {
        const row = await prisma.groupCronSettings.upsert({
          where: { telegramChatId: String(targetId) },
          create: {
            telegramChatId: String(targetId),
            matchWeekday: draft.weekday,
            matchHour: time.hour,
            matchMinute: time.minute,
          },
          update: {
            matchWeekday: draft.weekday,
            matchHour: time.hour,
            matchMinute: time.minute,
          },
        });
        const tzNote = row.timezone?.trim() || DEFAULT_CRON_TIMEZONE;
        await ctx.reply(
          `Матчинг: каждый ${formatWeekdayRu(draft.weekday)} в ${pad2(time.hour)}:${pad2(time.minute)}. Пояс: ${tzNote}. Cron обновлён.`
        );
      }

      await reschedule();
    });
}
