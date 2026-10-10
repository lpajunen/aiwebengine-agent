/**
 * The list of a person's conversations, and what deleting one removes.
 *
 * A conversation is one run id, and the `runs` table has a row per run, so
 * the list is read from there: one row each, ordered by when it was last
 * active, paged by that time. Conversations older than the table have no row
 * of their own; `legacyRuns` is how they get one.
 */

/** How many conversations one page of the list holds. */
export const CONVERSATIONS_PER_PAGE = 30;

/** Every table holding a conversation's rows, keyed by user and run. */
export const CONVERSATION_TABLES = [
  "messages",
  "activities",
  "attachments",
  "interjections",
  "plans",
  "turn_usage",
  "sent_prompts",
  "run_scripts",
  "runs",
];

/** A conversation's title: its first prompt, on one line, cut to 80. */
export function conversationTitle(prompt: unknown): string {
  const title = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 80 ? title.slice(0, 79) + "…" : title;
}

/**
 * One page of a list read with one row more than a page: the page, and the
 * cursor for the next one when that extra row says there is more.
 */
export function pageOf<T extends { updated_ms?: unknown }>(
  rows: T[],
  size: number,
): { items: T[]; next: number | null } {
  if (rows.length <= size) return { items: rows, next: null };
  const items = rows.slice(0, size);
  return { items, next: Number(items[items.length - 1].updated_ms) };
}

interface PromptRow {
  user_id?: unknown;
  run_id?: unknown;
  message?: unknown;
  created_ms?: unknown;
}

/**
 * The `runs` rows that conversations started before the table existed are
 * missing, built from their prompts: started at the first, last active at the
 * last, titled by the first. `existing` holds `user|run` for every run that
 * already has a row. Prompts are expected oldest first.
 */
export function legacyRuns(
  prompts: PromptRow[],
  existing: Set<string>,
): Record<string, unknown>[] {
  const found: Record<string, Record<string, unknown>> = {};
  const order: string[] = [];
  for (const prompt of prompts) {
    const userId = String(prompt.user_id ?? "");
    const runId = String(prompt.run_id ?? "");
    if (!userId || !runId) continue;
    const key = userId + "|" + runId;
    if (existing.has(key)) continue;
    const at = Number(prompt.created_ms ?? 0);
    if (!found[key]) {
      found[key] = {
        user_id: userId,
        run_id: runId,
        run_state: "done",
        run_mode: "plan",
        run_kind: "chat",
        steps: 0,
        title: conversationTitle(prompt.message),
        created_ms: at,
        updated_ms: at,
      };
      order.push(key);
    } else if (at > Number(found[key].updated_ms)) {
      found[key].updated_ms = at;
    }
  }
  return order.map((key) => found[key]);
}
