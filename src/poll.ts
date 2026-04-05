import type { ParticipationChoice } from "@prisma/client";

export const POLL_QUESTION = "Random Coffee на эту неделю: участвуешь?";

export const POLL_OPTIONS = ["Участвую", "Не участвую"] as const;

/** Telegram `poll_answer.option_ids` are 0-based indices into `POLL_OPTIONS`. */
export function choiceFromOptionIds(optionIds: number[]): ParticipationChoice | null {
  if (optionIds.length !== 1) return null;
  const i = optionIds[0];
  if (i === 0) return "PARTICIPATE";
  if (i === 1) return "NOT_PARTICIPATE";
  return null;
}
