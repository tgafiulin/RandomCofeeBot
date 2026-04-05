export function isValidIanaTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_ALIASES: Record<string, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 0,
  вс: 0,
  пн: 1,
  вт: 2,
  ср: 3,
  чт: 4,
  пт: 5,
  сб: 6,
  воскресенье: 0,
  понедельник: 1,
  вторник: 2,
  среда: 3,
  четверг: 4,
  пятница: 5,
  суббота: 6,
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const WEEKDAY_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

export function formatWeekdayRu(weekday: number): string {
  return WEEKDAY_RU[weekday] ?? String(weekday);
}

export function parseWeekday(raw: string): number | null {
  const key = raw.trim().toLowerCase();
  if (key in WEEKDAY_ALIASES) return WEEKDAY_ALIASES[key]!;
  return null;
}

export function parseClock(raw: string): { hour: number; minute: number } | null {
  const s = raw.trim();
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] !== undefined ? Number(m[2]) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function commandArgsFromText(text: string): string[] {
  const trimmed = text.trim();
  const i = trimmed.indexOf(" ");
  if (i === -1) return [];
  return trimmed
    .slice(i + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Build node-cron 5-field expression (minute hour * * weekday). */
export function toWeeklyCronExpression(
  weekday: number,
  hour: number,
  minute: number
): string {
  return `${minute} ${hour} * * ${weekday}`;
}
