export type ScheduleDraftKind = "poll" | "match";

export type ScheduleDraft = {
  kind: ScheduleDraftKind;
  weekday: number;
  chatId: number;
  userId: number;
  expiresAt: number;
};

const TTL_MS = 15 * 60 * 1000;
const drafts = new Map<string, ScheduleDraft>();

function draftKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function setScheduleDraft(draft: Omit<ScheduleDraft, "expiresAt">): void {
  drafts.set(draftKey(draft.chatId, draft.userId), {
    ...draft,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function getScheduleDraft(chatId: number, userId: number): ScheduleDraft | undefined {
  const k = draftKey(chatId, userId);
  const d = drafts.get(k);
  if (!d) return undefined;
  if (Date.now() > d.expiresAt) {
    drafts.delete(k);
    return undefined;
  }
  return d;
}

export function clearScheduleDraft(chatId: number, userId: number): void {
  drafts.delete(draftKey(chatId, userId));
}

export function clearScheduleDraftsForUser(userId: number): void {
  for (const [k, d] of drafts) {
    if (d.userId === userId) drafts.delete(k);
  }
}

/** True if this user is waiting to send чч:мм for /schedule (any target group). */
export function hasScheduleDraftForUser(userId: number): boolean {
  const now = Date.now();
  for (const d of drafts.values()) {
    if (d.userId === userId && now <= d.expiresAt) return true;
  }
  return false;
}
