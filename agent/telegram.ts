/**
 * Which conversation a Telegram message belongs to.
 *
 * A chat has no "New conversation" button and no list to pick from, so the
 * conversation is inferred: the chat's latest run, while it is recent, and a
 * fresh one after a quiet spell or when the person says `/new`. A message
 * that arrives while that run is still working is said to it, as the page's
 * Send does, rather than starting a second run beside it.
 */

/**
 * How long a chat's conversation stays open after it last did anything.
 * Long enough to come back to a document after a meeting; short enough that
 * tomorrow's unrelated question does not pay to resend today's history.
 */
export const CONVERSATION_IDLE_MS = 3 * 60 * 60 * 1000;

/** As much of a `runs` row as the choice needs. */
export interface ChatRun {
  run_id?: unknown;
  run_state?: unknown;
  created_ms?: unknown;
  updated_ms?: unknown;
}

export type Route =
  /** Open a new conversation with this message. */
  | { kind: "start" }
  /** Give this finished conversation its next prompt. */
  | { kind: "continue"; runId: string }
  /** Say this to the run still working on the conversation. */
  | { kind: "say"; runId: string }
  /** The run is working and the message carries files, which only a prompt can. */
  | { kind: "busy"; runId: string };

/**
 * Where a message goes, given the chat's latest run and when the person last
 * sent `/new` on its own (0 if never): a run created before that is behind
 * the boundary they drew.
 *
 * A run idle past the window is left alone even when its row still says it
 * is working: a run that stopped without saying so must not swallow every
 * message after it as something said to a turn that never comes.
 */
export function routeMessage(
  latest: ChatRun | null,
  now: number,
  freshSince: number,
  fresh: boolean,
  hasFiles: boolean,
): Route {
  const runId = String(latest?.run_id ?? "");
  if (fresh || !runId) return { kind: "start" };
  if (Number(latest?.created_ms ?? 0) < freshSince) return { kind: "start" };
  if (now - Number(latest?.updated_ms ?? 0) > CONVERSATION_IDLE_MS) {
    return { kind: "start" };
  }
  const state = String(latest?.run_state ?? "");
  if (state === "running" || state === "waiting") {
    return hasFiles ? { kind: "busy", runId } : { kind: "say", runId };
  }
  return { kind: "continue", runId };
}
