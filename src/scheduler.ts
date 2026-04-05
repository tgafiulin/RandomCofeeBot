import cron from "node-cron";
import type { Api } from "grammy";
import { prisma } from "./db/client.js";
import { startPollRound } from "./services/startPollRound.js";
import { runMatchRound } from "./services/matchRound.js";
import { toWeeklyCronExpression } from "./scheduleParse.js";
import { DEFAULT_CRON_TIMEZONE } from "./cronConstants.js";

const tasks: ReturnType<typeof cron.schedule>[] = [];

export function stopCronJobs(): void {
  for (const t of tasks) {
    t.stop();
  }
  tasks.length = 0;
}

function trimOrEmpty(s: string | undefined): string {
  return s?.trim() ?? "";
}

type CronBucket = { expr: string; timezone: string; chatIds: number[] };

function bucketKey(timezone: string, expr: string): string {
  return `${timezone}\n${expr}`;
}

function resolveTimezoneForChat(groupTzOverride: string | null | undefined): string {
  const g = trimOrEmpty(groupTzOverride ?? undefined);
  return g || DEFAULT_CRON_TIMEZONE;
}

export async function rescheduleCronJobs(api: Api, whitelistChatIds: number[]): Promise<void> {
  stopCronJobs();

  if (whitelistChatIds.length === 0) {
    return;
  }

  const settingsRows = await prisma.groupCronSettings.findMany({
    where: {
      OR: whitelistChatIds.map((id) => ({ telegramChatId: String(id) })),
    },
  });

  const settingsByChat = new Map<number, (typeof settingsRows)[0]>();
  for (const row of settingsRows) {
    settingsByChat.set(Number(row.telegramChatId), row);
  }

  const pollBuckets = new Map<string, CronBucket>();
  const matchBuckets = new Map<string, CronBucket>();

  for (const chatId of whitelistChatIds) {
    const s = settingsByChat.get(chatId);
    if (s?.cronDisabled) {
      console.log(`Cron: чат ${chatId} — автоматика выключена (/scheduleoff), пропуск.`);
      continue;
    }

    const tz = resolveTimezoneForChat(s?.timezone ?? undefined);

    let pollExpr: string | null = null;
    if (s?.pollWeekday != null && s.pollHour != null) {
      pollExpr = toWeeklyCronExpression(s.pollWeekday, s.pollHour, s.pollMinute ?? 0);
    }

    if (pollExpr) {
      if (!cron.validate(pollExpr)) {
        console.error(`Cron: невалидное выражение опроса для чата ${chatId}: "${pollExpr}"`);
      } else {
        const key = bucketKey(tz, pollExpr);
        if (!pollBuckets.has(key)) {
          pollBuckets.set(key, { expr: pollExpr, timezone: tz, chatIds: [] });
        }
        pollBuckets.get(key)!.chatIds.push(chatId);
      }
    }

    let matchExpr: string | null = null;
    if (s?.matchWeekday != null && s.matchHour != null) {
      matchExpr = toWeeklyCronExpression(s.matchWeekday, s.matchHour, s.matchMinute ?? 0);
    }

    if (matchExpr) {
      if (!cron.validate(matchExpr)) {
        console.error(`Cron: невалидное выражение матчинга для чата ${chatId}: "${matchExpr}"`);
      } else {
        const key = bucketKey(tz, matchExpr);
        if (!matchBuckets.has(key)) {
          matchBuckets.set(key, { expr: matchExpr, timezone: tz, chatIds: [] });
        }
        matchBuckets.get(key)!.chatIds.push(chatId);
      }
    }
  }

  for (const b of pollBuckets.values()) {
    const task = cron.schedule(
      b.expr,
      () => {
        void (async () => {
          for (const id of b.chatIds) {
            const r = await startPollRound(api, id);
            if (!r.ok && r.reason === "existing_open") {
              console.warn(`[cron poll] chat ${id}: уже есть открытый раунд, пропуск.`);
            } else if (!r.ok) {
              console.error(`[cron poll] chat ${id}:`, r);
            } else {
              console.log(`[cron poll] chat ${id}: опрос создан.`);
            }
          }
        })();
      },
      { timezone: b.timezone }
    );
    tasks.push(task);
    console.log(`Cron poll: "${b.expr}" (${b.timezone}) → чаты: ${b.chatIds.join(", ")}`);
  }

  for (const b of matchBuckets.values()) {
    const task = cron.schedule(
      b.expr,
      () => {
        void (async () => {
          for (const id of b.chatIds) {
            const r = await runMatchRound(api, id);
            if (!r.ok && r.reason === "no_round") {
              console.warn(`[cron match] chat ${id}: нет открытого раунда, пропуск.`);
            } else if (!r.ok && r.reason === "no_participants") {
              console.warn(`[cron match] chat ${id}: нет участников «Участвую», пропуск.`);
            } else if (!r.ok) {
              console.error(`[cron match] chat ${id}:`, r);
            } else {
              console.log(`[cron match] chat ${id}: результаты отправлены.`);
            }
          }
        })();
      },
      { timezone: b.timezone }
    );
    tasks.push(task);
    console.log(`Cron match: "${b.expr}" (${b.timezone}) → чаты: ${b.chatIds.join(", ")}`);
  }
}
