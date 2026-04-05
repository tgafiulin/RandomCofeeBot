/** Telegram user ids allowed to run admin commands (comma-separated). */
export function parseAdminTelegramIds(): Set<number> {
  return new Set(parseAdminTelegramIdsOrdered());
}

/** Same ids as in .env, left to right (order preserved if needed later). */
export function parseAdminTelegramIdsOrdered(): number[] {
  const raw = process.env.ADMIN_TELEGRAM_IDS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

export function isAdminUser(telegramUserId: number, admins: Set<number>): boolean {
  return admins.has(telegramUserId);
}
