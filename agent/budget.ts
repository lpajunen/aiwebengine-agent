/**
 * What a run has spent, and when it has had enough.
 *
 * Apart from `main.ts` for the reason `protocol.ts` gives — a root script
 * cannot `export`, so nothing inside one is reachable by a test. The pieces
 * here are the arithmetic and the thresholds; reading the rows and acting on
 * the verdict stay with the loop.
 *
 * Two of this project's three most expensive bugs were arithmetic of exactly
 * this kind, and neither raised anything. A `LIMIT` read oldest-first served
 * one run its first sixty rows forever, so it reasoned about a conversation
 * that had stopped moving. And prompt sizes were summed when every turn
 * resends the one before it, which measures nothing — `largestPrompt` is a
 * maximum, and the compaction trigger reads it.
 *
 * Covered by `budget.test.ts`.
 */

/**
 * Rows one run may accumulate before it is stopped.
 *
 * A ceiling, not a window — and the difference is the whole of why this is
 * not simply a `LIMIT` on the read. A conversation cannot be truncated at an
 * arbitrary row: this run has exactly one genuine user message, the prompt,
 * and every later one carries `tool_result` blocks the API requires to be
 * preceded by the matching `tool_use` in the message immediately before. So
 * dropping rows off the front either starts the conversation on an assistant
 * turn or orphans tool results, and both are refused outright. There is no
 * valid truncation point except the beginning, which is the prompt.
 *
 * Summarising and carrying on — compaction — is the real answer to a run this
 * long, and it is built: `COMPACT_AT_ROWS` sits at 70% of this, so a run folds
 * itself well before it arrives here. Which makes this a backstop rather than
 * the working limit. A run that reaches it has had a compaction fail or be
 * skipped, so it has gone wrong and is stopped where it stands.
 *
 * `MAX_STEPS` should have ended it long before either: twelve turns is roughly
 * twenty-five rows.
 */
export const MAX_HISTORY_ROWS = 60;

/**
 * What the read asks for: one row more than the ceiling.
 *
 * The extra row is the whole mechanism. Reading exactly `MAX_HISTORY_ROWS`
 * makes "at the limit" and "past it" the same answer, so a run that had gone
 * wrong would look like a run that had not — which is the shape the
 * oldest-first bug had, and it stayed invisible for the same reason.
 *
 * Derived here rather than written at the call site so that the two cannot
 * drift apart; `over_the_history_ceiling` in the suite pins the pair.
 */
export const HISTORY_QUERY_LIMIT = MAX_HISTORY_ROWS + 1;

/**
 * When a run's conversation is folded into a summary and carried on.
 *
 * Either trigger is enough. Tokens are the real measure and come from the
 * last turn's `usage`; rows are the backstop that keeps `MAX_HISTORY_ROWS`
 * from ever being reached, since hitting it stops the run outright.
 *
 * The token figure is the dial worth turning. Too low and a run pays for a
 * summary it did not need; too high and every turn carries a conversation
 * nobody is reading. It is well under the model's 200k window on purpose —
 * what makes a long run expensive here is resending it every turn, not
 * running out of room.
 */
export const COMPACT_AT_TOKENS = 30000;
export const COMPACT_AT_ROWS = Math.floor(MAX_HISTORY_ROWS * 0.7);

/** Whether this run has passed the ceiling rather than merely reached it. */
export function overHistoryLimit(rowCount: number): boolean {
  return rowCount > MAX_HISTORY_ROWS;
}

/**
 * Whether this run's conversation should be folded up before the next turn.
 *
 * The floor of four rows is not a rounding-off. A conversation with fewer has
 * nothing worth summarising and would pay a model call to say so, and a run
 * whose very first turn reported a large prompt — a long skill index, a big
 * paste — would otherwise compact before it had done anything.
 */
export function shouldCompact(
  rowCount: number,
  largestPrompt: number,
): boolean {
  if (rowCount < 4) return false;
  if (rowCount >= COMPACT_AT_ROWS) return true;
  return largestPrompt >= COMPACT_AT_TOKENS;
}

/**
 * How many turns this run has taken, from the counter and from the rows.
 *
 * The larger of the two, because each covers the other's gap. The counter can
 * be behind — a turn that ran and failed to record itself — and the rows can
 * be behind after a compaction, which replaces a conversation of many
 * assistant messages with a single user one. Taking the maximum means neither
 * a lost write nor a fold can hand a run back turns it has already spent.
 */
export function stepsFrom(
  recorded: unknown,
  assistantMessages: number,
): number {
  if (recorded === undefined || recorded === null) return assistantMessages;
  const counted = Number(recorded);
  if (!isFinite(counted)) return assistantMessages;
  return Math.max(counted, assistantMessages);
}

/**
 * Turns taken since the latest prompt of a conversation.
 *
 * `base` is how many assistant messages the conversation held when that prompt
 * began. Subtracting it starts a continued conversation's budget at zero; a
 * compaction that leaves fewer assistant messages than the base clamps to
 * zero, and the counter on the row is what holds.
 */
export function stepsSincePrompt(
  recorded: unknown,
  assistantMessages: number,
  base: unknown,
): number {
  const earlier = Number(base ?? 0);
  const before = isFinite(earlier) ? earlier : 0;
  return stepsFrom(recorded, Math.max(0, assistantMessages - before));
}

/** What a run has cost so far. */
export interface Spend {
  turns: number;
  cached: number;
  wrote: number;
  fresh: number;
  output: number;
  /**
   * The biggest single prompt, not the sum of them.
   *
   * Every turn resends the turn before it, so adding prompt sizes measures a
   * quantity nothing spent. What a run's context actually costs at its widest
   * is one number, and it is this one — which is also why the compaction
   * trigger reads it rather than the total.
   */
  largestPrompt: number;
}

/** A run that has spent nothing, and the shape every fold below starts from. */
export function emptySpend(): Spend {
  return {
    turns: 0,
    cached: 0,
    wrote: 0,
    fresh: 0,
    output: 0,
    largestPrompt: 0,
  };
}

/**
 * Fold a run's usage rows into what it cost.
 *
 * Takes `unknown[]` rather than a row type, because the module loader has no
 * `import type` and because that is what a database answers with anyway. Each
 * field is coerced on the way in, so a row missing a column contributes zero
 * rather than `NaN` — one absent value must not turn a whole run's cost into
 * something a page renders as "NaN tokens".
 */
export function spendOf(rows: unknown[]): Spend {
  const spend = emptySpend();
  for (const row of rows) {
    const fields = (row ?? {}) as Record<string, unknown>;
    const cached = count(fields.cached_tokens);
    const wrote = count(fields.wrote_tokens);
    const fresh = count(fields.fresh_tokens);
    spend.turns += 1;
    spend.cached += cached;
    spend.wrote += wrote;
    spend.fresh += fresh;
    spend.output += count(fields.out_tokens);
    const prompt = cached + wrote + fresh;
    if (prompt > spend.largestPrompt) spend.largestPrompt = prompt;
  }
  return spend;
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return isFinite(n) ? n : 0;
}
