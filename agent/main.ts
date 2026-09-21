/// <reference path="../types/aiwebengine.d.ts" />

/**
 * A prompt-driven agent that runs inside aiwebengine.
 *
 * The run lives in the engine. `POST /agent/prompt` queues the first turn and
 * answers; each turn queues the next; the page watches the SSE stream. Closing
 * the tab does not stop anything.
 *
 * This used to be the other way round — the browser posted one request per
 * turn — because three engine facts left nowhere else for a turn to run:
 * `registerOnce` took effect only during `init()`, a scheduled job ran as
 * `UserContext::admin("scheduler")` and so could not reach the person's own
 * API key, and `dispatcher.sendMessage` ran its listeners inline. All three
 * are gone. `personalTasks` is the replacement for all of them: a durable
 * queue whose work runs *as the person who asked for it*, so their key
 * resolves and `personalStorage` answers.
 *
 * Two things that follow from running while the person is away.
 *
 * It takes their consent. `personalTasks.enqueue` refuses without a live
 * grant, which they give on the engine's consent page and can withdraw from
 * their account page — withdrawing also cancels whatever is still queued. The
 * grant has to cover both scopes this agent uses: `secrets` for the model key
 * and `personal_storage` for the remember/recall notes.
 *
 * And a turn is attempted exactly once. The queue retries a failed task by
 * default, which for a turn would mean re-sending the whole conversation and
 * paying for a second model call on somebody's personal key — so every enqueue
 * here passes `maxAttempts: 1` and lets `MAX_STEPS` do the bounding.
 *
 * The answer arrives as it is written. `callModel` reads the model's response
 * with `fetchStream` and pushes the text on as it becomes readable, so the
 * page fills in rather than waiting out the whole turn in silence. Only the
 * stream carries the pieces: the tables are still written once, by the tool
 * that produced the text, so nothing about reopening the page later changes.
 *
 * And the prompt is cached, which is what makes resending the run every turn
 * affordable — though not until a run passes 4096 tokens, since that is this
 * model's minimum and it is the highest of any current tier. See the request
 * body in `callModel`, and `logUsage` for the evidence that it is working.
 */

// ============================================================================
// Configuration
// ============================================================================

/**
 * The model every run uses.
 *
 * Haiku for now, on cost: an agent turn resends the whole conversation, so the
 * bill grows with the length of a run rather than with the prompt. It was also
 * the only tier that fitted when a turn had ten seconds; a turn is now a job
 * with `javascript.job_timeout_ms`, so speed is no longer what decides this.
 *
 * Changing this is not only the string. Haiku 4.5 rejects
 * `output_config.effort`, and takes thinking as
 * `{type: "enabled", budget_tokens: N}` rather than adaptive; the server-side
 * refusal fallback below belongs to the Opus 5 / Fable tier. Moving up to
 * `claude-opus-5` means putting all three back.
 */
const MODEL = "claude-haiku-4-5";

/**
 * What the model costs, in dollars per million tokens.
 *
 * **These move with `MODEL`.** A price list is the one constant here that goes
 * wrong quietly: the wrong number still renders, still looks authoritative,
 * and tells somebody spending their own money something false. So it sits
 * against the model above rather than anywhere more convenient, and the four
 * rates are kept apart rather than folded into one — caching is most of what
 * this run costs or saves, and an average would hide exactly the thing the
 * display exists to show.
 *
 * The multipliers are the API's, not this script's: a cache read is a tenth
 * of the input rate and a cache write is a quarter more than it.
 */
const PRICES = {
  freshPerM: 1.0,
  cacheWritePerM: 1.25,
  cacheReadPerM: 0.1,
  outputPerM: 5.0,
};

/** What the model can hold, for the meter on the page. */
const CONTEXT_WINDOW = 200000;

const API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Where each person's own API key lives: `user_secrets`, keyed by
 * (script, user, name). The engine never hands the value back to JavaScript —
 * `secretStorage` can only say whether it exists — so the only way to use it
 * is the `{{secret:...}}` header template, resolved host-side for the calling
 * user. This script cannot read, log or forward anybody's key.
 */
const SECRET_NAME = "ANTHROPIC_API_KEY";

/**
 * One turn's output ceiling.
 *
 * A turn now runs as a queued task, so its budget is `javascript.job_timeout_ms`
 * — 60 s by default rather than the 10 s a request gets, and raisable for this
 * script alone:
 *
 *     set_script_limits script=<this script> jobTimeoutMs=120000
 *
 * That is the dial to turn before this one. 1024 was chosen when a turn had
 * ten seconds and 2048 measurably did not fit; with a job's budget there is
 * room to raise it, and room to move up a model tier — see MODEL above for the
 * three things that change with it.
 *
 * `fetch` is still synchronous and its timeout still clamped to what is left
 * of the budget, so generation remains the part that scales with this number.
 */
const MAX_TOKENS = 1024;

/**
 * Assistant turns one run may take before the script stops it.
 *
 * This is now the only thing bounding the length of a run: compaction keeps
 * the conversation from growing without limit, so a run ends because it has
 * taken enough turns rather than because it ran out of room. Raising it is
 * therefore a decision about money rather than about correctness — every turn
 * is a model call on somebody's own key.
 *
 * Counted on the run's row rather than by scanning the history, which stopped
 * working when compaction started throwing the history away: a compacted run
 * has no assistant messages left to count.
 */
const MAX_STEPS = 12;

const STREAM_PATH = "/agent/events";

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
 * Summarising the middle and carrying on — compaction — is the real answer to
 * a run this long, and it is not built. Until it is, a run that gets here has
 * gone wrong and is stopped where it stands.
 *
 * `MAX_STEPS` should have ended it long before: twelve turns is roughly
 * twenty-five rows.
 */
const MAX_HISTORY_ROWS = 60;

/** Asides delivered to one turn. Beyond this they wait for the next. */
const MAX_INTERJECTIONS = 10;

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
const COMPACT_AT_TOKENS = 30000;
const COMPACT_AT_ROWS = Math.floor(MAX_HISTORY_ROWS * 0.7);

/**
 * What the summariser is told to keep.
 *
 * Everything before the summary is discarded, so this is all the model will
 * have of its own earlier work — which is why the instruction is about what
 * to retain rather than about being brief.
 */
const COMPACT_PROMPT = [
  "You are compacting a conversation so it can continue in less space.",
  "Write a summary that lets the assistant carry on as if it still",
  "remembered everything. Keep: what the person originally asked for, in",
  "their words where it matters; what has been established or decided;",
  "what tools were used and what they returned that still matters; what is",
  "left to do. Drop: pleasantries, restatements, and anything already",
  "superseded. Write it as notes to yourself, not as a reply to anyone.",
].join(" ");

const SYSTEM_PROMPT = [
  "You are an assistant embedded in a web page.",
  "Answer by calling the write_response tool: that is how the person sees what",
  "you say, and you can call it and then carry on working. Always answer, even",
  "when the answer is short or the news is bad. If you end a turn with plain",
  "text and no tool call, that text is delivered as your answer and the run",
  "ends there — so never end a turn having said nothing at all.",
  "Use remember for anything worth keeping between runs, list_memories to see",
  "what you already know about this person, and recall to read one back.",
  "When the work is more than one step — fetching something, trying each of",
  "several things, shaping data before you can answer — write it as code and",
  "call run_js. One call does what a tool call each would have taken a turn",
  "apiece to do, and you have twelve turns.",
].join(" ");

// ============================================================================
// Memory
// ============================================================================

/**
 * Where a person's notes live inside their own store.
 *
 * Prefixed rather than stored bare, because `personalStorage` belongs to the
 * script as a whole: anything else this agent keeps per person would otherwise
 * be enumerated as though the model had written it.
 */
const NOTE_PREFIX = "note:";

/**
 * How many notes `list_memories` will name, and how much of each it shows.
 *
 * Enumerating costs a round trip per key and another per value, so this is a
 * bound on the work as much as on the tokens.
 */
const MAX_MEMORIES = 100;
const MEMORY_PREVIEW_CHARS = 160;

interface Memory {
  key: string;
  preview: string;
  chars: number;
}

/**
 * What a run has spent so far.
 *
 * Summed over turns, except `largestPrompt`, which is the biggest single
 * prompt the run sent — the sum of prompts is not a context measurement,
 * because every turn resends the one before it.
 */
interface Spend {
  turns: number;
  cached: number;
  wrote: number;
  fresh: number;
  output: number;
  largestPrompt: number;
}

interface UsageRow {
  cached_tokens: number;
  wrote_tokens: number;
  fresh_tokens: number;
  out_tokens: number;
}

/**
 * Where a run has got to.
 *
 * `running` is the ordinary case and `done` is the end of one. `cancelled` is
 * a person stopping it. `waiting` is a run suspended for an answer only a
 * person can give — an approved plan, a permission prompt — and it is named
 * here although nothing yet puts a run into it.
 *
 * That is deliberate rather than speculative. Cancel, interject, plan mode and
 * per-tool approval are not four features; they are one question — may this
 * run take another turn, and what should it carry when it does — and building
 * them separately is how they end up disagreeing about what a suspended run
 * is. The half that stops a run is identical for all of them and is written
 * once, here: `advanceRun` proceeds only from `running`. What plan mode still
 * needs is the half that resumes one, plus a reason to show the person.
 */
type RunState = "running" | "waiting" | "cancelled" | "done";

interface RunRow {
  id: number;
  run_id: string;
  run_state: string;
  task_id: string;
  steps?: number;
}

interface InterjectionRow {
  id: number;
  body: string;
}

// ============================================================================
// Skills
// ============================================================================

/**
 * Where a skill lives: `skills/<name>/SKILL.md`, plus whatever files it
 * references beside it.
 *
 * Assets rather than anything in this file, so that a deployment grows its own
 * library without editing the script — which is the whole point. The folder
 * name is the skill's name, because it is the one identifier that cannot
 * disagree with itself; a `name:` in the front matter is allowed and ignored,
 * so a SKILL.md written for another harness drops in unchanged.
 */
const SKILLS_PREFIX = "skills/";
const SKILL_FILE = "SKILL.md";

/**
 * How many skills the index will name.
 *
 * The index is the part that costs tokens on every single turn, so it is the
 * part with a ceiling. Bodies are read on demand and are not bounded by this.
 */
const MAX_SKILLS = 64;

/** A skill body handed to the model, in characters. */
const MAX_SKILL_CHARS = 32000;

interface Skill {
  name: string;
  description: string;
}

/** One entry of `assetStorage.listAssets()`. */
interface AssetInfo {
  name: string;
  updatedAt?: number;
}

// ============================================================================
// Code as the action
// ============================================================================

/**
 * What model-written code is allowed to do.
 *
 * This is the whole of the security argument for `run_js`, so it is a list of
 * four names and a list of what is deliberately missing.
 *
 * A tool call is one verb per round trip, and a run gets twelve. Code is the
 * other shape: a loop, a condition and an intermediate value cost one call
 * between them. Every project that adopts it has to build a sandbox first —
 * here the sandbox is what the script was already running inside, and
 * `sandbox.run` is the engine handing a script a way to run *part* of itself
 * holding less than it holds. The checks sit underneath the JavaScript, so
 * nothing the model writes, and no arrangement of the transcript, reaches past
 * them. A filtered tool list can be argued past; this cannot.
 *
 * What is granted:
 *
 * - `view_logs` is `console`, and on a turn that failed it is usually the only
 *   part worth reading.
 * - `use_network` is `fetch` and `fetchAll`, and is most of the reason to have
 *   the tool at all — without it this is a calculator.
 * - `read_assets` is the script's own files, which is where a skill keeps the
 *   data it points the model at.
 * - `read_storage` is this person's notes, so code can work over what the
 *   agent already knows rather than recalling them one key at a time.
 *
 * What is withheld, each for its own reason rather than out of caution:
 *
 * - **`read_secrets`.** It gates `{{secret:...}}` inside a `fetch`, which the
 *   engine substitutes host-side for whoever the run belongs to. Granted here,
 *   three lines of model-written code would post this person's API key to a
 *   URL of the model's choosing, and there is no version of that which is
 *   acceptable. It is also what stops the code spending their money on model
 *   calls of its own.
 * - **`read_script_data`.** `database.query` is scoped to the *script*, not to
 *   the person. This script's tables hold every run every person has ever had,
 *   so granting it would let one person's turn read another's conversation and
 *   hand it back as a tool result.
 * - **Every write.** Nothing here writes: not storage, not the database, not
 *   assets, not the queue. A wrong read costs a token and a wrong write costs
 *   a rollback, and the place to spend that asymmetry is an approval step that
 *   does not exist yet. `remember` remains the one write the model has, and it
 *   is a tool because it is worth a person seeing in the activity log.
 *
 * The residual risk is worth naming rather than leaving implied: `read_storage`
 * and `use_network` together are two legs of the lethal trifecta — private
 * data and a way out. The third is untrusted content, and this agent has none
 * today, because the only text in a run is what the person typed themselves.
 * **The first channel adapter adds it**, and the fix is not a narrower list
 * here but a run that holds fewer of these when it was started by somebody
 * other than the account owner.
 *
 * Intersected with `sandbox.held()` rather than passed as written: `run` throws
 * when asked to keep something the caller does not hold, and a delegation grant
 * is free to be narrower than this list. Asking for what is there and taking
 * what is given keeps a read-only grant working instead of failing every call.
 */
const CODE_CAPABILITIES: Capability[] = [
  "view_logs",
  "use_network",
  "read_assets",
  "read_storage",
];

/**
 * How long model-written code may run.
 *
 * Well inside the turn's own budget rather than up against it. A nested
 * execution is already clamped to whatever the parent has left, so the ceiling
 * that matters is not the engine's — it is that a turn still has to record
 * what happened and queue its successor after the code returns. Code that
 * loops forever should cost the rest of one turn, not the run.
 */
const CODE_TIMEOUT_MS = 15000;

/**
 * How much of a run's result is handed back to the model.
 *
 * A tool result is not paid for once. It is stored in the conversation and
 * resent on every turn after it, so a `fetch` of a large page pasted whole
 * would be bought again twelve times over — which is the bill, and then the
 * context, and then compaction arriving early to throw it away.
 *
 * Each part has its own ceiling and the whole has a backstop, and the order
 * the parts are joined in decides what the backstop eats: the value goes last,
 * so a `fetch` of something enormous is what gets trimmed rather than the
 * console output above it. Somebody who printed their working meant the
 * working to be read.
 */
const MAX_CODE_VALUE_CHARS = 3000;
const MAX_CODE_CONSOLE_LINES = 40;
const MAX_CODE_LINE_CHARS = 400;
const MAX_CODE_RESULT_CHARS = 4000;

/** Stack frames kept from a failure, once the engine's own are dropped. */
const MAX_CODE_STACK_FRAMES = 5;

/** How much of the source the person is shown in the activity log. */
const CODE_ECHO_CHARS = 2000;

// ============================================================================
// The model's tools
// ============================================================================

/**
 * `strict: true` needs `additionalProperties: false` and `required`, and buys
 * arguments that are guaranteed to match the schema — worth having when the
 * handler below trusts the shape.
 */
const TOOLS: ToolSpec[] = [
  {
    name: "write_response",
    description:
      "Send a message to the person who wrote the prompt. This is the only way they see anything you produce.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The message, as plain text or markdown.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "remember",
    description:
      "Store a note for this person. It survives between runs and is private to them.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "A short name for the note." },
        value: { type: "string", description: "What to store." },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_memories",
    description:
      "List what you have remembered about this person, with a preview of each. Use this before assuming you know nothing about them — notes survive between runs, and recall needs a key you would otherwise have to guess.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "recall",
    description: "Read back a note stored earlier with remember.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The note's name." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "run_js",
    description:
      "Run JavaScript and get the value back. Reach for this whenever the work is more than one step: fetching something, trying each of several things in turn, or shaping data before you can answer. A loop, a condition and an intermediate value cost one call here, where asking for a tool per step costs a turn each. " +
      "The value of the LAST EXPRESSION is the result — `const x = 1;` gives you nothing back, `const x = 1; x` gives you 1. `return` at the top level is a syntax error. Everything here is synchronous: `fetch(url, options)` hands back the response itself rather than a promise, and `fetchAll([...])` runs several at once. Top-level `await` is a syntax error, and you will not need one. `console.log` comes back whether or not the code worked, so print your working. " +
      "It runs holding less than the rest of this agent does: it can call the network, read this script's assets, and read this person's stored notes. It cannot write anything, cannot reach a stored secret, and cannot query the database. That is enforced by the engine underneath the JavaScript, not by this description, so do not try to work around it — use remember to store something and write_response to say something.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "The code to run, ending in the expression whose value you want back.",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    strict: true,
  },
];

/**
 * Offered only when the deployment actually has skills.
 *
 * A tool whose every answer is "there are none" is worse than no tool: it
 * spends a step to learn nothing and invites the model to keep asking. The
 * tool list is therefore a property of the skill library rather than of the
 * turn, so it is as stable across a run as the rest of the cached prefix.
 *
 * `file` is required rather than optional because `strict: true` wants every
 * property in `required`, and the description carries the default instead —
 * which also gives a skill somewhere to send the model next, since a SKILL.md
 * may name files beside it.
 */
const READ_SKILL_TOOL: ToolSpec = {
  name: "read_skill",
  description:
    "Read a skill's instructions before doing the kind of work it covers. Skill names are listed in the system prompt.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The skill's name, as listed in the system prompt.",
      },
      file: {
        type: "string",
        description:
          "Which file to read from the skill's folder. Use SKILL.md unless that file points you at another one.",
      },
    },
    required: ["name", "file"],
    additionalProperties: false,
  },
  strict: true,
};

// ============================================================================
// Shapes
// ============================================================================

/**
 * A tool as the API takes it.
 *
 * Spelled out rather than inferred from the literals: inference gives each
 * tool a type describing only the properties *that* tool has, so a list of
 * them is a union no fourth tool can join.
 */
/** What makes one model call differ from the ordinary kind. */
interface CallOptions {
  summarise?: boolean;
}

interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  strict: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ApiMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

interface ApiResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  stop_details?: { category?: string; explanation?: string } | null;
  error?: { message?: string };
}

interface MessageRow {
  id: number;
  speaker: string;
  blocks: string;
}

/**
 * One frame of the streaming Messages API.
 *
 * The streamed form does not send content blocks, it sends instructions for
 * building them — a start, a run of deltas, a stop — so these are the shapes
 * of the instructions rather than of the answer.
 */
interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: ContentBlock;
  delta?: StreamDelta;
  /** `message_start` carries the prompt's cost; `message_delta` the reply's. */
  message?: { usage?: StreamUsage };
  usage?: StreamUsage;
  error?: { message?: string };
}

/**
 * What a turn cost, as the stream reports it.
 *
 * `input_tokens` is the uncached remainder only, so the prompt's real size is
 * all three added together — reading the one field is how a run that was
 * almost entirely cache hits looks like a run that barely sent anything.
 */
interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface StreamDelta {
  type?: string;
  text?: string;
  partial_json?: string;
  thinking?: string;
  signature?: string;
  stop_reason?: string;
  stop_details?: { category?: string; explanation?: string } | null;
}

/**
 * A turn under construction, and what of it has already reached the page.
 *
 * `blocks` ends up being exactly the array a buffered response would have
 * handed over whole, which is what lets `advanceRun` stay unaware that any of
 * this happened.
 */
interface Turn {
  blocks: ContentBlock[];
  /** Tool arguments arrive as JSON in pieces; one accumulator per block. */
  partialJson: string[];
  /** How much of a block's answer text has already been sent, per block. */
  delivered: number[];
  stopReason: string | null;
  stopDetails: { category?: string; explanation?: string } | null;
  sawStop: boolean;
  usage: StreamUsage;
  /** Text held back until the end of the network read that produced it. */
  outbound: string;
}

interface ActivityRow {
  run_id: string;
  kind: string;
  message: string;
  created_ms: number;
}

// ============================================================================
// Registration
// ============================================================================

/**
 * A database answer, or a thrown error if the call failed.
 *
 * `database` reports failure as a `{error}` value rather than by throwing, so
 * an unchecked call is a failure that surfaces somewhere else and much later.
 * This script shipped with `ensureTable` unchecked and `role` as a column
 * name — a reserved keyword — so the table was never created, `init()`
 * registered its routes anyway, and the first symptom was a step answering
 * "No such run" about a run that had been opened perfectly well.
 */
/**
 * A read that survives the first failure after a column is added.
 *
 * Postgres caches a prepared statement per pooled connection, and adding a
 * column to a table makes every cached plan for it wrong: the next query on
 * each of those connections fails once with "cached plan must not change
 * result type", and the failure is itself what re-prepares it. So the second
 * attempt succeeds, and one retry is the whole fix.
 *
 * Worth doing rather than shrugging at, because of what the failure looks
 * like when it is swallowed. Every reader here answers "no rows" on error,
 * and "no rows" from the `runs` table means a run that is not running — a
 * live run reads as finished, its turns stop being counted, and the page
 * offers to start a new one. That is the bug this agent already shipped once
 * from a different cause, and a transient database error is no better a
 * reason for it than a missing row was.
 */
function queryRows(
  table: string,
  filter: string,
  limit: number,
  orderBy: string,
  direction: "asc" | "desc",
): unknown[] {
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rows = must(
        database.query(table, filter, limit, orderBy, direction),
        `reading ${table}`,
      );
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * A write that survives the first failure after a column is added, for the
 * same reason `queryRows` does — an `UPDATE` has a cached plan too, and this
 * was found by watching four turns in five go uncounted.
 *
 * The retry is safe because every caller writes a value it computed before
 * asking, rather than one derived from what it read: applying it twice leaves
 * the same row. That is a property of these callers and not of writes in
 * general, so it belongs in this comment rather than being assumed.
 */
function writeRow(run: () => DatabaseAnswer, what: string): boolean {
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      must(run(), what);
      return true;
    } catch (e) {
      last = e;
    }
  }
  console.log(`agent: ${what} failed: ${String(last)}`);
  return false;
}

function must(answer: DatabaseAnswer, what: string): unknown {
  const value = answer.json();
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "error" in value
  ) {
    throw new Error(`${what}: ${String((value as { error: unknown }).error)}`);
  }
  return value;
}

function init(): void {
  // Column names are validated against `^[a-z][a-z0-9_]*$` *and* refused when
  // they are SQL reserved words, which is why this is `speaker` rather than
  // the obvious `role`.
  must(
    database.ensureTable(
      "messages",
      JSON.stringify({
        columns: [
          { name: "user_id", type: "text" },
          { name: "run_id", type: "text" },
          { name: "speaker", type: "text" },
          { name: "blocks", type: "text" },
          { name: "created_ms", type: "bigint" },
        ],
      }),
    ),
    'creating the table "messages"',
  );

  must(
    database.ensureTable(
      "activities",
      JSON.stringify({
        columns: [
          { name: "user_id", type: "text" },
          { name: "run_id", type: "text" },
          { name: "kind", type: "text" },
          { name: "message", type: "text" },
          { name: "created_ms", type: "bigint" },
        ],
      }),
    ),
    'creating the table "activities"',
  );

  // A run's own row: what state it is in, and which queued task will take it
  // forward. Without one there was nothing to cancel — the run was only ever
  // implied by the rows that mentioned its id.
  must(
    database.ensureTable(
      "runs",
      JSON.stringify({
        columns: [
          { name: "user_id", type: "text" },
          { name: "run_id", type: "text" },
          { name: "run_state", type: "text" },
          { name: "task_id", type: "text" },
          { name: "steps", type: "bigint" },
          { name: "created_ms", type: "bigint" },
          { name: "updated_ms", type: "bigint" },
        ],
      }),
    ),
    'creating the table "runs"',
  );

  // What the person said while the agent was working. A table rather than a
  // column on the run, so two tabs interjecting at once cannot lose one to a
  // read-modify-write, and so the text lands in the conversation at a defined
  // point rather than wherever it happened to arrive.
  must(
    database.ensureTable(
      "interjections",
      JSON.stringify({
        columns: [
          { name: "user_id", type: "text" },
          { name: "run_id", type: "text" },
          { name: "body", type: "text" },
          { name: "created_ms", type: "bigint" },
        ],
      }),
    ),
    'creating the table "interjections"',
  );

  // Column names avoid anything SQL might claim: `output` and `usage` are
  // both words a database has opinions about, and a rejected ensureTable is
  // the failure this script has already shipped once.
  must(
    database.ensureTable(
      "turn_usage",
      JSON.stringify({
        columns: [
          { name: "user_id", type: "text" },
          { name: "run_id", type: "text" },
          { name: "cached_tokens", type: "bigint" },
          { name: "wrote_tokens", type: "bigint" },
          { name: "fresh_tokens", type: "bigint" },
          { name: "out_tokens", type: "bigint" },
          { name: "created_ms", type: "bigint" },
        ],
      }),
    ),
    'creating the table "turn_usage"',
  );

  routeRegistry.registerAssetRoute("/agent", "ui.html");
  routeRegistry.registerAssetRoute("/agent/app.js", "app.js");

  routeRegistry.registerRoute("/agent/prompt", "startRun", "POST", {
    tags: ["Agent"],
    summary: "Accept a prompt and open a run",
  });
  routeRegistry.registerRoute("/agent/cancel", "cancelRun", "POST", {
    tags: ["Agent"],
    summary: "Stop a run that is still working",
  });
  routeRegistry.registerRoute("/agent/say", "interject", "POST", {
    tags: ["Agent"],
    summary: "Say something to a run already in progress",
  });
  routeRegistry.registerRoute("/agent/history", "readHistory", "GET", {
    tags: ["Agent"],
    summary: "Everything this person's agent has done",
  });
  routeRegistry.registerRoute("/agent/key", "readKeyStatus", "GET", {
    tags: ["Agent"],
    summary: "Whether this person has stored an API key",
  });
  routeRegistry.registerRoute("/agent/key", "storeKey", "POST", {
    tags: ["Agent"],
    summary: "Store this person's own API key",
  });
  routeRegistry.registerRoute("/agent/key", "forgetKey", "DELETE", {
    tags: ["Agent"],
    summary: "Remove this person's stored API key",
  });

  // No route advances a run: `advanceRun` is reached by the queue, named by
  // the `handler` each enqueue carries.

  routeRegistry.registerStreamRoute(STREAM_PATH, "tagConnection", {
    tags: ["Agent"],
    summary: "Live activity for the signed-in person",
  });

  console.log("agent: routes registered");
}

// ============================================================================
// Stream
// ============================================================================

/**
 * Tags an SSE connection with whose it is, so `sendStreamMessageFiltered` can
 * reach one person's tabs and nobody else's.
 *
 * Never returns `{}`: empty connection criteria match *every* message, so an
 * anonymous listener would be handed all of them. The placeholder is a value
 * no message is ever sent with.
 */
function tagConnection(context: HandlerContext): Record<string, string> {
  const auth = context.request?.auth;
  if (!auth || !auth.isAuthenticated || !auth.userId) {
    return { userId: "(anonymous)" };
  }
  return { userId: auth.userId };
}

// ============================================================================
// Handlers
// ============================================================================

function startRun(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  if (!secretStorage.exists(SECRET_NAME)) {
    return json(400, {
      error: "Store your own API key before running the agent.",
      needsKey: true,
    });
  }

  let prompt = "";
  try {
    const body = (context.request?.json() ?? {}) as { prompt?: string };
    prompt = String(body.prompt ?? "").trim();
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!prompt) return json(400, { error: "A prompt is required." });

  const authorization = personalTasks.authorization();
  if (!authorization.granted) {
    // Not an error: they simply have not been asked yet, or the grant has
    // lapsed. The page sends them to `consentUrl` and they come back.
    return json(403, {
      error: authorization.expired
        ? "Your authorisation for this agent has expired."
        : "This agent needs your permission to work while you are away.",
      needsAuthorization: true,
      consentUrl: authorization.consentUrl,
    });
  }

  const runId = newRunId();
  appendMessage(userId, runId, "user", [{ type: "text", text: prompt }]);
  recordActivity(userId, runId, "prompt", prompt);

  // The run is the engine's from here. Queued rather than run inline so this
  // answers immediately, and `maxAttempts: 1` because a retried turn is a
  // second model call charged to this person for the same work.
  try {
    const task = personalTasks.enqueue({
      handler: "advanceRun",
      payload: { runId: runId },
      maxAttempts: 1,
    });
    openRun(userId, runId, task.taskId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordActivity(
      userId,
      runId,
      "error",
      `Could not start the run: ${message}`,
    );
    return json(500, { error: message });
  }

  return json(202, { runId });
}

/**
 * One turn: read the run, ask the model once, run whatever tools it named, and
 * queue the next turn if there is one.
 *
 * A task handler rather than a route. It runs as the person who started the
 * run — `context.request.auth.userId` is the identity the engine re-derived
 * from their grant when the task was claimed — so their key resolves and their
 * notes answer, exactly as they did when this was a request under their
 * session.
 *
 * One turn per task rather than a loop inside one, for the reason the loop was
 * never inside a request either: several model calls do not fit one execution
 * budget. A chain of tasks also survives a restart, which one long run does
 * not — it would be killed mid-conversation and started again from the top.
 */
function advanceRun(context: HandlerContext): void {
  const userId = signedInUser(context);
  if (!userId) {
    // The engine refuses to run a delegated task whose grant has gone, so
    // reaching here without a person means something the script cannot fix.
    console.log("agent: a turn ran with no person; abandoning it");
    return;
  }

  const task = context.meta?.task;
  const payload = (task?.payload ?? {}) as { runId?: string };
  const runId = String(payload.runId ?? "");
  if (!runId) {
    console.log("agent: a turn was queued with no runId");
    return;
  }

  // Only a run that is still running takes another turn. This is the single
  // gate every kind of stop goes through — a person's cancel today, a plan
  // awaiting approval later — which is why it reads the state rather than
  // asking whether a cancel happened.
  // Fails open: a run with no row is one whose bookkeeping failed or which
  // predates the table, and work already accepted is not abandoned over a
  // missing record of it.
  const state = runStateOf(userId, runId);
  if (state !== null && state !== "running") {
    console.log(`agent: run ${runId} is ${state}; not taking another turn`);
    return;
  }

  // Whatever the person said while the last turn was working, delivered here
  // so the model sees it before it decides anything.
  for (const said of takeInterjections(userId, runId)) {
    if (!said) continue;
    appendMessage(userId, runId, "user", [{ type: "text", text: said }]);
  }

  const history = loadMessages(userId, runId);
  if (history.length === 0) {
    console.log(`agent: no such run ${runId}`);
    return;
  }

  // Over the ceiling. Stopped rather than truncated, because there is nowhere
  // valid to truncate — see `MAX_HISTORY_ROWS`.
  if (history.length > MAX_HISTORY_ROWS) {
    recordActivity(
      userId,
      runId,
      "error",
      `Stopped: this run passed ${MAX_HISTORY_ROWS} messages without finishing.`,
    );
    finishRun(userId, runId, "history-limit");
    return;
  }

  const taken = stepsTaken(userId, runId, history);
  if (taken >= MAX_STEPS) {
    recordActivity(
      userId,
      runId,
      "error",
      `Stopped after ${MAX_STEPS} turns without finishing.`,
    );
    finishRun(userId, runId, "step-limit");
    return;
  }

  // Folded up before the turn rather than after it, and then the turn is
  // queued rather than taken here: a summary is a model call, the turn is
  // another, and one execution gets one — the same reason the loop was never
  // inside a single request. The next turn reads the summary as its whole
  // conversation.
  if (needsCompacting(userId, runId, history)) {
    if (compactRun(userId, runId, history)) {
      try {
        const task = personalTasks.enqueue({
          handler: "advanceRun",
          payload: { runId: runId },
          maxAttempts: 1,
        });
        setRunState(userId, runId, "running", task.taskId, "running");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        recordActivity(userId, runId, "error", `The run stopped: ${message}`);
        finishRun(userId, runId, "error");
      }
      return;
    }
    // Could not summarise. Carrying on with the conversation as it stands is
    // better than stopping, and the ceiling still catches a run that grows
    // past what can be sent at all.
  }

  countStep(userId, runId, taken);

  let answer: ApiResponse;
  try {
    answer = callModel(userId, runId, history.map(toApiMessage));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordActivity(userId, runId, "error", message);
    finishRun(userId, runId, "error");
    return;
  }

  // A refusal is an HTTP 200 with no usable content, so this has to be read
  // before `content` is touched. This model tier does not produce one, but the
  // branch is what makes moving up a tier a one-line change.
  if (answer.stop_reason === "refusal") {
    const why = answer.stop_details?.explanation ?? "The model declined.";
    recordActivity(userId, runId, "error", why);
    finishRun(userId, runId, "refusal");
    return;
  }

  const blocks = answer.content ?? [];
  // Stored whole, thinking blocks included: a later turn on the same model
  // replays them unchanged.
  appendMessage(userId, runId, "assistant", blocks);

  // Whether this turn is going on to do something decides what its prose is.
  // Text alongside a tool call is the model saying what it is about to do;
  // text with no tool call is the answer, because a turn that calls nothing
  // ends the run and there is nothing else it could be. Asked for in the
  // system prompt and then settled here, since a weaker model will sometimes
  // answer in prose however firmly it was told to use the tool — and the
  // person is owed their answer either way.
  const proseKind = proseKindFor(blocks);

  let said = false;
  const results: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      recordActivity(userId, runId, proseKind, block.text);
      said = true;
      continue;
    }
    if (block.type !== "tool_use" || !block.id || !block.name) continue;

    const outcome = runTool(
      userId,
      runId,
      block.name,
      (block.input ?? {}) as Record<string, unknown>,
    );
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: outcome.content,
      is_error: outcome.isError,
    });
  }

  // A turn that neither spoke nor did anything would end the run in silence,
  // which reads as the agent having crashed. It happens when a turn is cut
  // off at `max_tokens` before any block is complete.
  if (!said && results.length === 0) {
    recordActivity(
      userId,
      runId,
      "error",
      answer.stop_reason === "max_tokens"
        ? "The reply was cut off before anything was said. MAX_TOKENS may be too low."
        : "The model ended the turn without saying anything.",
    );
  }

  if (results.length > 0) {
    // Every result in one user message: splitting them teaches the model to
    // stop calling tools in parallel.
    appendMessage(userId, runId, "user", results);

    // The next turn, queued rather than run here — same reasoning as the
    // first: one model call per execution budget. Enqueueing is what replaced
    // the browser posting the next step.
    // Re-read rather than trusting the check at the top: a cancel can land
    // during the model call, which is the one part of a turn that cannot be
    // interrupted. Catching it here stops the run a whole turn earlier than
    // the next gate would.
    const now = runStateOf(userId, runId);
    if (now !== null && now !== "running") {
      console.log(`agent: run ${runId} was stopped mid-turn`);
      return;
    }

    try {
      const task = personalTasks.enqueue({
        handler: "advanceRun",
        payload: { runId: runId },
        maxAttempts: 1,
      });
      setRunState(userId, runId, "running", task.taskId, "running");
    } catch (e) {
      // Most likely the grant was withdrawn mid-run, which is the person
      // saying stop. Recorded so the page shows why it ended.
      const message = e instanceof Error ? e.message : String(e);
      recordActivity(userId, runId, "error", `The run stopped: ${message}`);
      finishRun(userId, runId, "error");
    }
    return;
  }

  finishRun(userId, runId, answer.stop_reason ?? "end_turn");
}

/**
 * What this turn's prose is: the answer, or talk about what it is doing.
 *
 * A turn that calls no tool ends the run, so its text is the last thing the
 * person will hear and is therefore the answer — whether or not the model
 * bothered with `write_response`. Text beside a tool call is narration, and
 * stays a note.
 *
 * The rule lives here rather than in the loop because it is the whole of what
 * decides whether somebody's answer arrives looking like an aside.
 */
function proseKindFor(blocks: ContentBlock[]): "note" | "response" {
  for (const block of blocks) {
    if (block.type === "tool_use" && block.id && block.name) return "note";
  }
  return "response";
}

/**
 * Tell the person's open tabs that the run is over.
 *
 * The page used to learn this from the step response it was waiting on. It no
 * longer waits on anything, so the end of a run has to arrive the same way
 * everything else does.
 */
function finishRun(userId: string, runId: string, reason: string): void {
  // Anything said after the last turn read the queue has nowhere to go: the
  // run is over and no turn will collect it. Saying so is the whole
  // difference between a sentence that was lost and one that was lost
  // silently — and silently is how a prompt typed into a run that had already
  // ended disappeared without trace.
  for (const said of takeInterjections(userId, runId)) {
    recordActivity(
      userId,
      runId,
      "error",
      `Not delivered, the run ended first: "${said}"`,
    );
  }

  // Only from `running`: a turn that finishes normally must not overwrite a
  // cancel that landed while it was working, or the page would be told the
  // run ended by itself and the row would say the same.
  setRunState(userId, runId, "done", undefined, "running");
  recordActivity(userId, runId, "done", reason);
}

/**
 * Stop a run.
 *
 * Two things, because one is not enough. The queued task is cancelled so a
 * turn that has not started never does; and the run's state is written so a
 * turn already in flight stops at the next gate. Cancelling the task alone
 * leaves a running turn to queue its own successor, and writing the state
 * alone leaves a pending task to wake up and read it — which works, but burns
 * an execution slot to do nothing.
 */
function cancelRun(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let runId = "";
  try {
    const body = (context.request?.json() ?? {}) as { runId?: string };
    runId = String(body.runId ?? "").trim();
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!runId) return json(400, { error: "A runId is required." });

  const row = runRow(userId, runId);
  // Scoped to this person in the query, so another account's run id finds
  // nothing rather than being stopped.
  if (!row) return json(404, { error: "No such run." });

  const state = String(row.run_state ?? "running");
  if (state !== "running" && state !== "waiting") {
    // Already over. Not an error: the person pressed stop as it finished.
    return json(200, { runId: runId, state: state, alreadyEnded: true });
  }

  if (row.task_id) {
    try {
      personalTasks.cancel(String(row.task_id));
    } catch (e) {
      // The task may have been claimed already, which is exactly the case the
      // state write below covers.
    }
  }

  setRunState(userId, runId, "cancelled");
  recordActivity(userId, runId, "note", "Stopped by you.");
  recordActivity(userId, runId, "done", "cancelled");
  return json(200, { runId: runId, state: "cancelled" });
}

/**
 * Say something to a run that is already working.
 *
 * Queued rather than appended to the conversation here: the turn in flight has
 * already read the history, so text written now would sit before an assistant
 * message that never saw it, and the turn after would read that as an aside
 * already answered. `takeInterjections` delivers it at the top of a turn,
 * which is the only point where "the model has not decided anything yet" is
 * true.
 */
function interject(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let runId = "";
  let text = "";
  try {
    const body = (context.request?.json() ?? {}) as {
      runId?: string;
      text?: string;
    };
    runId = String(body.runId ?? "").trim();
    text = String(body.text ?? "").trim();
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!runId) return json(400, { error: "A runId is required." });
  if (!text) return json(400, { error: "Nothing to say." });

  // Fails closed: without a row saying the run is alive, this is not a run
  // that can be spoken to. The page turns the refusal into a new prompt, so
  // the words are not lost.
  if (!runIsLive(userId, runId)) {
    return json(409, {
      error: "That run has already finished.",
      runEnded: true,
      state: runStateOf(userId, runId) ?? "done",
    });
  }

  try {
    must(
      database.insert(
        "interjections",
        JSON.stringify({
          user_id: userId,
          run_id: runId,
          body: text,
          created_ms: Date.now(),
        }),
      ),
      "queueing something to say",
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, { error: message });
  }

  // Shown at once rather than when it is delivered, because the person has
  // said it and should see that it landed. A kind of its own so the page does
  // not mistake it for the start of a new run.
  recordActivity(userId, runId, "interject", text);
  return json(202, { runId: runId });
}

function readHistory(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  const rows = must(
    database.query(
      "activities",
      JSON.stringify({ user_id: userId }),
      MAX_HISTORY_ROWS,
      "id",
      "desc",
    ),
    "reading the history",
  ) as ActivityRow[];

  const ordered = Array.isArray(rows) ? rows.slice().reverse() : [];

  // The run the page is about to show the tail of — its spend is the one
  // worth loading, and it is the only one bounded by `MAX_STEPS`.
  const latestRun =
    ordered.length > 0 ? String(ordered[ordered.length - 1].run_id ?? "") : "";

  return json(200, {
    activities: ordered.map((row) => ({
      runId: row.run_id,
      kind: row.kind,
      message: row.message,
      at: Number(row.created_ms),
    })),
    hasKey: secretStorage.exists(SECRET_NAME),
    authorization: personalTasks.authorization(),
    runId: latestRun,
    // So a page opened while a run is working shows a stop button, rather
    // than learning the run exists only if a turn happens to land.
    runState: latestRun ? (runStateOf(userId, latestRun) ?? "done") : "done",
    spend: runSpend(userId, latestRun),
    // Sent rather than duplicated in the page, so the rates the numbers were
    // costed with cannot drift away from the model that produced them.
    pricing: PRICES,
    contextWindow: CONTEXT_WINDOW,
  });
}

function readKeyStatus(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });
  return json(200, {
    hasKey: secretStorage.exists(SECRET_NAME),
    authorization: personalTasks.authorization(),
  });
}

/**
 * Stores the caller's own key. It lands in `user_secrets` under their user id,
 * so each person pays for their own tokens and nobody — this script included —
 * can read anybody else's.
 */
function storeKey(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let key = "";
  try {
    const body = (context.request?.json() ?? {}) as { key?: string };
    key = String(body.key ?? "").trim();
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!key) return json(400, { error: "A key is required." });

  const outcome = secretStorage.setSecret(SECRET_NAME, key);
  if (outcome.indexOf("Error") === 0) {
    return json(400, { error: outcome });
  }
  return json(200, { hasKey: true });
}

function forgetKey(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });
  secretStorage.removeSecret(SECRET_NAME);
  return json(200, { hasKey: false });
}

// ============================================================================
// The model call
// ============================================================================

/**
 * One request to the Messages API, read as it arrives.
 *
 * Raw HTTP rather than the Anthropic SDK because there is no npm here: a
 * script's imports resolve through the engine's module loader over its own
 * assets, so the SDK cannot be installed.
 *
 * The key is never in this process. `x-api-key` carries the secret template
 * the engine substitutes host-side, for whoever the execution is running as —
 * which for a queued turn is the person who started the run, by their grant.
 *
 * The template is substituted anywhere inside a header value, so
 * `Authorization: Bearer {{secret:...}}` works too. It did not once, and this
 * comment used to say so.
 *
 * This was `fetch` until the engine grew `fetchStream`. `fetch` returns only
 * once the whole body has arrived, so a person learned what the model said one
 * turn at a time and a turn is as long as the model takes to finish thinking —
 * the agent's longest silence was the part where it was working hardest.
 * `fetchStream` hands back the status and headers immediately and the body in
 * pieces, which is what lets an answer appear while it is still being written.
 *
 * What comes back from here is the same `ApiResponse` it always was. The
 * streaming is contained in this section on purpose: `advanceRun` stores
 * blocks and dispatches tools exactly as it did, and cannot tell that the
 * answer was assembled rather than parsed.
 */
function callModel(
  userId: string,
  runId: string,
  messages: ApiMessage[],
  options?: CallOptions,
): ApiResponse {
  // A summarising call is a different request in three ways, and each of them
  // would be a quiet mistake left alone. It offers no tools, because it is not
  // a turn and must not start one. Its text is not streamed, because the
  // person is waiting for an answer and a summary of the conversation is not
  // it. And it asks for no cache entry: its system prompt differs, so the
  // prefix cannot match anything already stored, and writing one pays the
  // premium on bytes nothing will ever read back.
  const summarising = options?.summarise === true;
  const skills = summarising ? [] : loadSkills();
  const stream = fetchStream(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": "{{secret:" + SECRET_NAME + "}}",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Both of these follow the skill library rather than the turn, so they
      // are as stable across a run as anything else in the cached prefix.
      system: summarising ? COMPACT_PROMPT : systemPromptFor(skills),
      messages: messages,
      tools: summarising
        ? undefined
        : skills.length > 0
          ? TOOLS.concat([READ_SKILL_TOOL])
          : TOOLS,
      stream: true,
      // Cache the prompt, which for this loop means the conversation.
      //
      // A breakpoint caches everything *before* it, and the top-level form
      // puts one at the end of the last block and moves it forward as the
      // conversation grows — so this single field covers the tools, the
      // system prompt and every turn so far. Each turn reads back what the
      // turn before it wrote, which is the shape that makes resending the
      // whole run affordable.
      //
      // It does nothing at all until the whole prompt passes 4096 tokens,
      // and that number is the model's rather than a choice: Haiku 4.5 has
      // the highest minimum cacheable prefix of any current model, and a
      // shorter prefix is refused silently — no error, just a `usage` that
      // reports nothing cached. The tools and system prompt come to roughly
      // 400 tokens together, so caching *those* — the obvious thing to
      // reach for, and what this was expected to be — would never once have
      // fired. What crosses 4096 is a long conversation, which is exactly
      // the run whose bill is worth cutting.
      //
      // Moving up a tier lowers the threshold rather than raising it (512 on
      // Opus 5), so this starts paying sooner there, not later. The 5-minute
      // TTL is deliberate: a turn is queued the moment the one before it
      // ends, so every turn refreshes the entry, and the 1-hour TTL would
      // double the write price to buy a gap this loop does not have.
      cache_control: summarising ? undefined : { type: "ephemeral" },
      // No `output_config.effort` and no `thinking`: this model rejects the
      // first and does not take the adaptive form of the second. Both come
      // back if the model moves up a tier.
    }),
  });

  // The status is known before any of the body is, which is the other half of
  // what streaming buys: a 401 for a key that has been revoked is answered
  // without waiting for a response that was never coming.
  if (!stream.ok) {
    const detail = readErrorMessage(stream.text());
    throw new Error(`The model API answered ${stream.status}: ${detail}`);
  }

  try {
    return readModelStream(stream, userId, runId, summarising);
  } finally {
    // An abandoned stream holds a socket until the execution ends, and an
    // execution may hold only a few. Closing one that already finished is a
    // no-op, so this covers the thrown path without a second branch.
    stream.close();
  }
}

/**
 * Rebuild the turn from the frames that describe it, sending the answer on as
 * it becomes readable.
 */
function readModelStream(
  stream: FetchStream,
  userId: string,
  runId: string,
  silent?: boolean,
): ApiResponse {
  const turn: Turn = {
    blocks: [],
    partialJson: [],
    delivered: [],
    stopReason: null,
    stopDetails: null,
    sawStop: false,
    usage: {},
    outbound: "",
  };

  let buffer = "";
  for (const chunk of stream) {
    // A chunk is not a frame. Boundaries fall wherever the network put them,
    // so whatever follows the last blank line is half an event and waits for
    // the next read. Carriage returns are dropped rather than parsed around:
    // a raw one cannot appear inside a JSON string, so nothing is lost.
    buffer += chunk.split("\r").join("");

    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      applyEvent(turn, buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");
    }

    // One stream message per network read rather than one per delta. The model
    // sends text in pieces far smaller than anything a person can perceive,
    // and every send is a host call; the network has already done the
    // coalescing, so this borrows its framing rather than inventing a size.
    if (!silent) flush(turn, userId, runId);
  }

  // A last frame that arrived without its blank line. `applyEvent` ignores a
  // remainder holding no data line, which is the usual case.
  applyEvent(turn, buffer);
  if (!silent) flush(turn, userId, runId);
  // Whatever was held back is dropped rather than sent: a silent call's text
  // is going into the conversation, not onto the page.
  turn.outbound = "";

  logUsage(turn);
  recordUsage(userId, runId, turn.usage);

  if (!turn.sawStop) {
    // The body ended early. Saying so is better than returning a turn that
    // looks complete: `maxAttempts: 1` means nothing will retry it, so a
    // silent truncation would be stored as what the model said and replayed
    // as such on every turn after it.
    throw new Error("The model's answer ended before it was finished.");
  }

  return {
    content: turn.blocks,
    stop_reason: turn.stopReason ?? "end_turn",
    stop_details: turn.stopDetails,
  };
}

/**
 * One SSE frame, applied to the turn being built.
 *
 * The `event:` line is ignored: every frame's JSON carries the same name in
 * `type`, and reading one of the two is enough.
 */
function applyEvent(turn: Turn, frame: string): void {
  const data = frameData(frame);
  if (!data) return;

  let event: StreamEvent;
  try {
    event = JSON.parse(data) as StreamEvent;
  } catch (e) {
    // A frame that is not JSON is not something to guess at, and not a reason
    // to abandon a turn that is otherwise arriving.
    return;
  }

  switch (event.type) {
    case "message_start":
      // The prompt's cost, including how much of it the cache answered.
      if (event.message?.usage) turn.usage = event.message.usage;
      return;

    case "content_block_start": {
      const index = event.index ?? 0;
      turn.blocks[index] = (event.content_block ?? {
        type: "text",
      }) as ContentBlock;
      turn.partialJson[index] = "";
      turn.delivered[index] = 0;
      return;
    }

    case "content_block_delta":
      applyDelta(turn, event.index ?? 0, event.delta ?? {});
      return;

    case "content_block_stop":
      closeBlock(turn, event.index ?? 0);
      return;

    case "message_delta":
      if (event.delta?.stop_reason) turn.stopReason = event.delta.stop_reason;
      if (event.delta?.stop_details) {
        turn.stopDetails = event.delta.stop_details;
      }
      // The reply's length is only known once it has stopped.
      if (typeof event.usage?.output_tokens === "number") {
        turn.usage.output_tokens = event.usage.output_tokens;
      }
      return;

    case "message_stop":
      turn.sawStop = true;
      return;

    case "error":
      // An error arriving mid-stream is a request that was answered 200 and
      // went wrong afterwards — the one failure a buffered `fetch` could only
      // report as a body that did not parse.
      throw new Error(event.error?.message ?? "The model stream failed.");

    default:
      // `ping`, and whatever the API grows next.
      return;
  }
}

/**
 * Write down what the turn cost and how much of it the cache paid for.
 *
 * The `usage` fields are the only evidence that caching is working: a prefix
 * that stopped matching still answers, still looks right, and is simply
 * billed in full — the failure announces itself nowhere else. So this is
 * logged on every turn rather than measured once and trusted, since what
 * breaks caching is a later change to how the prompt is assembled.
 *
 * In a healthy run `cached` grows turn over turn while `wrote` stays near the
 * size of what the last turn added. `cached` staying at 0 once a run is past
 * a few thousand tokens means the prefix is being rewritten somewhere above
 * the breakpoint.
 */
function logUsage(turn: Turn): void {
  const cached = turn.usage.cache_read_input_tokens ?? 0;
  const wrote = turn.usage.cache_creation_input_tokens ?? 0;
  const fresh = turn.usage.input_tokens ?? 0;
  console.log(
    "agent: prompt " +
      (cached + wrote + fresh) +
      " tokens (cached " +
      cached +
      ", wrote " +
      wrote +
      ", new " +
      fresh +
      "), reply " +
      (turn.usage.output_tokens ?? 0),
  );
}

function applyDelta(turn: Turn, index: number, delta: StreamDelta): void {
  const block = turn.blocks[index];
  if (!block) return;

  if (delta.type === "text_delta" && typeof delta.text === "string") {
    block.text = (block.text ?? "") + delta.text;
    // Prose the model wrote outside a tool call. The system prompt asks it to
    // speak through write_response instead, so this is the rarer path — but it
    // is shown rather than dropped, which is what `advanceRun` does with the
    // finished block too.
    turn.outbound += delta.text;
    return;
  }

  if (
    delta.type === "input_json_delta" &&
    typeof delta.partial_json === "string"
  ) {
    turn.partialJson[index] =
      (turn.partialJson[index] ?? "") + delta.partial_json;
    if (block.name === "write_response") deliverAnswer(turn, index);
    return;
  }

  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    block.thinking = String(block.thinking ?? "") + delta.thinking;
    return;
  }

  if (delta.type === "signature_delta" && typeof delta.signature === "string") {
    // Not shown and not read here, but a thinking block replayed on a later
    // turn is rejected without its signature.
    block.signature = String(block.signature ?? "") + delta.signature;
  }
}

/**
 * Send whatever of `write_response`'s text has become readable.
 *
 * The thing a person is waiting for is not a text block. This agent speaks
 * through a tool, so its answer arrives as the `text` argument of a tool call:
 * JSON, a fragment at a time. Waiting for that JSON to parse would mean
 * waiting for the whole answer, which is the thing streaming exists to stop —
 * so the half-written object is read directly and only what has grown since
 * last time is sent.
 */
function deliverAnswer(turn: Turn, index: number): void {
  const whole = jsonStringPrefix(turn.partialJson[index] ?? "", "text");
  const already = turn.delivered[index] ?? 0;
  let ready = whole.length;
  if (ready <= already) return;

  // A character outside the basic plane is two units and a JSON fragment can
  // end between them. Holding the first half back costs one read and saves
  // sending half a character to be drawn as a replacement glyph.
  const last = whole.charCodeAt(ready - 1);
  if (last >= 0xd800 && last <= 0xdbff) ready -= 1;
  if (ready <= already) return;

  turn.outbound += whole.slice(already, ready);
  turn.delivered[index] = ready;
}

/**
 * Turn the JSON that arrived in pieces into the arguments a tool call needs.
 *
 * `advanceRun` reads `input` off a finished block exactly as it did when the
 * whole response arrived at once, so the reassembly has to land here rather
 * than anywhere later.
 */
function closeBlock(turn: Turn, index: number): void {
  const block = turn.blocks[index];
  if (!block || block.type !== "tool_use") return;

  const raw = turn.partialJson[index] ?? "";
  try {
    block.input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (e) {
    // Arguments that did not parse leave the tool with nothing, which is what
    // it would have been handed anyway — and "a key is required" from the tool
    // is a better thing for the model to read back than a parse error.
    block.input = {};
  }
}

/**
 * Push what has accumulated to this person's open tabs.
 *
 * Nothing is written to the database here, and that is the point: the stream
 * is the convenience and the table is the record, so a delta is something a
 * page watches happen rather than something that happened. What the model
 * finally said is recorded once, by the tool that says it — which is why a
 * page opened tomorrow reads the table and misses none of this.
 */
function flush(turn: Turn, userId: string, runId: string): void {
  if (!turn.outbound) return;
  routeRegistry.sendStreamMessageFiltered(
    STREAM_PATH,
    { runId: runId, kind: "delta", message: turn.outbound, at: Date.now() },
    JSON.stringify({ userId: userId }),
    "subset",
  );
  turn.outbound = "";
}

/** The `data:` lines of one frame, joined as the SSE format defines. */
function frameData(frame: string): string {
  const parts: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.indexOf("data:") !== 0) continue;
    const value = line.slice(5);
    // One space after the colon is the field separator rather than content.
    parts.push(value.indexOf(" ") === 0 ? value.slice(1) : value);
  }
  return parts.join("\n");
}

/**
 * As much of a string field as a half-written JSON object will give up.
 *
 * `JSON.parse` is all-or-nothing and the object is by definition incomplete.
 * This reads the one field it is asked for and stops wherever the text runs
 * out — mid-escape included, since `\u00` is not yet a character and guessing
 * the rest would put the wrong one on somebody's screen.
 */
function jsonStringPrefix(partial: string, key: string): string {
  const marker = '"' + key + '"';
  const at = partial.indexOf(marker);
  if (at === -1) return "";

  let i = at + marker.length;
  while (i < partial.length && (partial[i] === " " || partial[i] === ":")) i++;
  if (partial[i] !== '"') return "";
  i++;

  let out = "";
  while (i < partial.length) {
    const c = partial[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }

    if (i + 1 >= partial.length) return out;
    const escape = partial[i + 1];
    if (escape === "u") {
      if (i + 6 > partial.length) return out;
      out += String.fromCharCode(parseInt(partial.slice(i + 2, i + 6), 16));
      i += 6;
      continue;
    }
    out += unescapeOne(escape);
    i += 2;
  }
  return out;
}

function unescapeOne(escape: string): string {
  switch (escape) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    // `"`, `\` and `/` stand for themselves.
    default:
      return escape;
  }
}

function readErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as ApiResponse;
    return parsed.error?.message ?? body.slice(0, 200);
  } catch (e) {
    return body.slice(0, 200);
  }
}

// ============================================================================
// The state of a run
// ============================================================================

/**
 * The run's own row, or null if it has none.
 *
 * Runs that predate this table have no row, and every reader treats that as
 * `running` — an old run must not become uncancellable *and* unstoppable
 * because a feature arrived after it started.
 */
function runRow(userId: string, runId: string): RunRow | null {
  if (!runId) return null;
  try {
    const rows = queryRows(
      "runs",
      JSON.stringify({ user_id: userId, run_id: runId }),
      1,
      "id",
      "desc",
    ) as RunRow[];
    return rows.length > 0 ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

/**
 * What state a run is in, or `null` when there is no row to say.
 *
 * Null rather than a default, because "no row" means opposite things to the
 * two questions asked of it, and answering both with one default is a bug
 * this shipped once. *May this run take another turn?* must say yes: a run
 * whose bookkeeping failed, or that started before the table existed, is
 * still a run and must not be stopped by the absence of a record of it.
 * *Is this run alive?* must say no: a finished run has no row either, and
 * treating that as alive leaves a page saying "working" forever and sends the
 * next thing the person types into a run that ended — which is exactly what
 * happened, and the prompt was queued for a turn that was never coming.
 *
 * So the default belongs at each call, where the cost of being wrong is
 * known. Work fails open; liveness fails closed.
 */
function runStateOf(userId: string, runId: string): RunState | null {
  const row = runRow(userId, runId);
  if (!row) return null;
  const state = String(row.run_state ?? "running");
  return state === "waiting" ||
    state === "cancelled" ||
    state === "done" ||
    state === "running"
    ? (state as RunState)
    : "running";
}

/** Whether a run can still be spoken to or stopped. Absence means no. */
function runIsLive(userId: string, runId: string): boolean {
  const state = runStateOf(userId, runId);
  return state === "running" || state === "waiting";
}

function openRun(userId: string, runId: string, taskId: string): void {
  // A run without a row still runs; it just cannot be cancelled or counted.
  // Losing the answer to keep the bookkeeping would be the wrong way round,
  // so a failure here is logged and not raised.
  writeRow(
    () =>
      database.insert(
        "runs",
        JSON.stringify({
          user_id: userId,
          run_id: runId,
          run_state: "running",
          task_id: taskId,
          steps: 0,
          created_ms: Date.now(),
          updated_ms: Date.now(),
        }),
      ),
    "opening a run",
  );
}

/**
 * Move a run along, and remember which task carries it next.
 *
 * `expected` is what the caller believes the run is, and the write is skipped
 * when it is not — so a turn finishing normally cannot overwrite a cancel that
 * landed while it was working. It is the one race this design actually has:
 * the person presses stop during a model call that cannot be interrupted, and
 * the turn then completes and would otherwise mark the run `done`.
 */
function setRunState(
  userId: string,
  runId: string,
  state: RunState,
  taskId?: string,
  expected?: RunState,
): boolean {
  const row = runRow(userId, runId);
  if (!row) return false;
  if (expected && String(row.run_state ?? "running") !== expected) return false;

  const patch: Record<string, unknown> = {
    run_state: state,
    updated_ms: Date.now(),
  };
  if (taskId !== undefined) patch.task_id = taskId;

  return writeRow(
    () => database.update("runs", Number(row.id), JSON.stringify(patch)),
    "moving a run along",
  );
}

/**
 * Everything the person said while this run was working, taken off the queue.
 *
 * Read and deleted together, so a turn cannot deliver the same aside twice.
 * Consumed at the top of a turn rather than written straight into `messages`
 * when it arrives, which is the part that matters: text appended mid-turn
 * would sit *before* an assistant message that never saw it, and the next
 * turn would read that as an aside already answered.
 */
function takeInterjections(userId: string, runId: string): string[] {
  let rows: InterjectionRow[] = [];
  try {
    rows = queryRows(
      "interjections",
      JSON.stringify({ user_id: userId, run_id: runId }),
      MAX_INTERJECTIONS,
      "id",
      "asc",
    ) as InterjectionRow[];
  } catch (e) {
    return [];
  }

  const said: string[] = [];
  for (const row of rows) {
    said.push(String(row.body ?? ""));
    try {
      must(
        database.delete("interjections", Number(row.id)),
        "clearing what was said mid-run",
      );
    } catch (e) {
      // Left on the queue it would be delivered again next turn. Dropping it
      // from this turn's batch is the lesser of the two.
      said.pop();
    }
  }
  return said;
}

// ============================================================================
// Compaction
// ============================================================================

/**
 * How many turns this run has taken.
 *
 * Counted on the row rather than by scanning the history, because compaction
 * throws the history away: a compacted run has no assistant messages left, so
 * counting them would hand every compacted run a fresh budget and a run could
 * never end. A run with no row falls back to counting, which is right for the
 * runs that predate the column — none of them can have been compacted.
 */
function stepsTaken(
  userId: string,
  runId: string,
  history: MessageRow[],
): number {
  const row = runRow(userId, runId);
  const counted = history.filter((m) => m.speaker === "assistant").length;
  if (!row || row.steps === undefined || row.steps === null) return counted;
  return Math.max(Number(row.steps), counted);
}

function countStep(userId: string, runId: string, taken: number): void {
  const row = runRow(userId, runId);
  if (!row) return;
  writeRow(
    () =>
      database.update(
        "runs",
        Number(row.id),
        JSON.stringify({ steps: taken + 1, updated_ms: Date.now() }),
      ),
    "counting a turn",
  );
}

/** Whether this run's conversation should be folded up before the next turn. */
function needsCompacting(
  userId: string,
  runId: string,
  history: MessageRow[],
): boolean {
  if (history.length < 4) return false;
  if (history.length >= COMPACT_AT_ROWS) return true;
  return runSpend(userId, runId).largestPrompt >= COMPACT_AT_TOKENS;
}

/**
 * Replace a run's conversation with a summary of it, and carry on.
 *
 * The whole history goes, not the older half of it. Keeping recent turns
 * verbatim is the shape that looks obviously better and is not: a kept turn
 * carries tool results whose `tool_use` sits in a message that was thrown
 * away, and the API requires the two to be adjacent — so a kept tail has to
 * begin at a boundary that this conversation, which has exactly one genuine
 * user message, mostly does not have. Summarise-and-replay-nothing is both
 * simpler and what the model is trained for.
 *
 * Safe at the top of a turn and nowhere else: by then every `tool_use` has
 * its `tool_result` beside it, because the turn that made the call also ran
 * the tools. Mid-turn there is a call waiting on an answer, and folding that
 * away asks the model to continue from a question it can no longer see.
 *
 * Returns false when the summary could not be had, and the caller goes on
 * with the conversation it already had — a run that cannot be compacted is
 * better than a run that stops.
 */
function compactRun(
  userId: string,
  runId: string,
  history: MessageRow[],
): boolean {
  let summary = "";
  try {
    const answer = callModel(
      userId,
      runId,
      history.map(toApiMessage).concat([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Summarise everything above, following your instructions.",
            },
          ],
        },
      ]),
      { summarise: true },
    );
    for (const block of answer.content ?? []) {
      if (block.type === "text" && block.text) summary += block.text;
    }
  } catch (e) {
    console.log("agent: could not summarise the run: " + String(e));
    return false;
  }

  summary = summary.trim();
  if (!summary) return false;

  // The swap is one transaction: a run left holding neither its conversation
  // nor a summary of it has lost the thread entirely, and there is nothing to
  // recover it from.
  try {
    must(database.beginTransaction(), "opening the swap");
    for (const row of history) {
      must(database.delete("messages", Number(row.id)), "clearing a message");
    }
    appendMessage(userId, runId, "user", [
      {
        type: "text",
        text:
          "[Everything before this point has been summarised to save space. " +
          "These are your own notes on the run so far.]\n\n" +
          summary +
          "\n\n[End of summary. Continue the work from here.]",
      },
    ]);
    must(database.commitTransaction(), "closing the swap");
  } catch (e) {
    try {
      database.rollbackTransaction();
    } catch (inner) {
      // Nothing further to do: the handler exiting rolls it back anyway.
    }
    console.log("agent: could not swap in the summary: " + String(e));
    return false;
  }

  console.log(
    `agent: compacted ${history.length} messages into ${summary.length} characters`,
  );
  recordActivity(
    userId,
    runId,
    "note",
    `Folded ${history.length} messages into a summary to save space.`,
  );
  return true;
}

// ============================================================================
// What a run costs
// ============================================================================

/**
 * Keep what this turn spent, and tell the person's open tabs.
 *
 * Written as one row per turn rather than a running total updated in place.
 * Appending cannot lose an earlier turn to a read-modify-write, and the sum
 * of twelve rows is not worth a column — `MAX_STEPS` is the bound on how many
 * there can be.
 *
 * Sent as a delta rather than a total because the page is already keeping one:
 * it loads the authoritative sum with its history and adds each turn as it
 * lands, so a message that never arrives is corrected by the next reload
 * rather than being wrong forever.
 *
 * Failing to record is not failing the turn. The model has already answered
 * and the person has already paid; losing the bookkeeping is worth strictly
 * less than losing the answer.
 */
function recordUsage(userId: string, runId: string, usage: StreamUsage): void {
  const cached = usage.cache_read_input_tokens ?? 0;
  const wrote = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  if (cached + wrote + fresh + output === 0) return;

  try {
    must(
      database.insert(
        "turn_usage",
        JSON.stringify({
          user_id: userId,
          run_id: runId,
          cached_tokens: cached,
          wrote_tokens: wrote,
          fresh_tokens: fresh,
          out_tokens: output,
          created_ms: Date.now(),
        }),
      ),
      "storing what a turn cost",
    );
  } catch (e) {
    console.log("agent: could not record what a turn cost: " + String(e));
    return;
  }

  routeRegistry.sendStreamMessageFiltered(
    STREAM_PATH,
    {
      runId: runId,
      kind: "spend",
      message: "",
      at: Date.now(),
      spend: {
        turns: 1,
        cached: cached,
        wrote: wrote,
        fresh: fresh,
        output: output,
        largestPrompt: cached + wrote + fresh,
      },
    },
    JSON.stringify({ userId: userId }),
    "subset",
  );
}

/** What one run has spent, read back from the rows its turns wrote. */
function runSpend(userId: string, runId: string): Spend {
  const spend: Spend = {
    turns: 0,
    cached: 0,
    wrote: 0,
    fresh: 0,
    output: 0,
    largestPrompt: 0,
  };
  if (!runId) return spend;

  let rows: UsageRow[] = [];
  try {
    rows = queryRows(
      "turn_usage",
      JSON.stringify({ user_id: userId, run_id: runId }),
      MAX_STEPS + 1,
      "id",
      "asc",
    ) as UsageRow[];
  } catch (e) {
    // A page that cannot say what a run cost is better than a page that will
    // not load.
    return spend;
  }

  for (const row of rows) {
    const cached = Number(row.cached_tokens ?? 0);
    const wrote = Number(row.wrote_tokens ?? 0);
    const fresh = Number(row.fresh_tokens ?? 0);
    spend.turns += 1;
    spend.cached += cached;
    spend.wrote += wrote;
    spend.fresh += fresh;
    spend.output += Number(row.out_tokens ?? 0);
    const prompt = cached + wrote + fresh;
    if (prompt > spend.largestPrompt) spend.largestPrompt = prompt;
  }
  return spend;
}

// ============================================================================
// Memory
// ============================================================================

/**
 * Every note this person has, with enough of each to choose between them.
 *
 * `recall` needs a key the model already knows, which made anything written
 * in an earlier run unreachable unless it happened to guess the name — memory
 * that could be written and not read. Enumeration is the whole fix.
 *
 * `key(index)` answers in ascending order, so the listing is stable between
 * calls without sorting it here.
 *
 * The cost is a round trip per key and another per value, which is why both
 * the count and the preview are bounded. Reading the values is deliberate
 * rather than free: a key like `trip-plan` says nothing about what is in it,
 * and a preview usually answers the question outright — a note short enough
 * to fit *is* its own preview, and no `recall` follows.
 */
function listMemories(): { memories: Memory[]; more: number } {
  const keys: string[] = [];
  const total = personalStorage.length;
  for (let i = 0; i < total; i++) {
    const stored = personalStorage.key(i);
    if (stored === null) continue;
    if (stored.indexOf(NOTE_PREFIX) !== 0) continue;
    keys.push(stored);
  }

  const shown = keys.slice(0, MAX_MEMORIES);
  const memories: Memory[] = [];
  for (const stored of shown) {
    const value = personalStorage.getItem(stored);
    // Null here means it went away between the two reads. Skipped rather than
    // reported: it is no longer a note, and nothing is owed about it.
    if (value === null) continue;
    memories.push({
      key: stored.slice(NOTE_PREFIX.length),
      preview: memoryPreview(value),
      chars: value.length,
    });
  }
  return { memories: memories, more: keys.length - shown.length };
}

/** The first line of a note, short enough to sit in a list. */
function memoryPreview(value: string): string {
  const firstLine = value.split("\n")[0].trim();
  if (firstLine.length <= MEMORY_PREVIEW_CHARS) return firstLine;
  return firstLine.slice(0, MEMORY_PREVIEW_CHARS) + "…";
}

function renderMemories(listing: { memories: Memory[]; more: number }): string {
  if (listing.memories.length === 0) {
    return "Nothing is remembered about this person yet. Use remember to keep something.";
  }

  const lines = ["Remembered about this person:"];
  for (const memory of listing.memories) {
    // The size is what tells the model whether the preview is the whole note
    // or the start of one, which is what decides whether to call recall.
    lines.push(`- ${memory.key} (${memory.chars} chars): ${memory.preview}`);
  }
  if (listing.more > 0) {
    lines.push(`...and ${listing.more} more, not listed.`);
  }
  lines.push("Use recall with a key to read one in full.");
  return lines.join("\n");
}

/** What to say when a key names nothing. */
function missingNote(key: string): string {
  let known: string[] = [];
  try {
    known = listMemories().memories.map((m) => m.key);
  } catch (e) {
    // The listing is a courtesy; failing to build it must not turn a plain
    // miss into an error.
    known = [];
  }
  if (known.length === 0) {
    return `Nothing is stored under "${key}", and nothing else is either.`;
  }
  return `Nothing is stored under "${key}". These exist: ${known.join(", ")}.`;
}

// ============================================================================
// Skills
// ============================================================================

function listAssetInfo(): AssetInfo[] {
  try {
    const parsed = JSON.parse(assetStorage.listAssets()) as AssetInfo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** The skill an asset belongs to, or null if it is not a skill's SKILL.md. */
function skillNameOf(assetName: string): string | null {
  if (assetName.indexOf(SKILLS_PREFIX) !== 0) return null;
  const rest = assetName.slice(SKILLS_PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut <= 0) return null;
  if (rest.slice(cut + 1) !== SKILL_FILE) return null;
  return rest.slice(0, cut);
}

/**
 * Every skill this deployment has, with the one line that says when it
 * applies.
 *
 * Sorted by name, and that is not cosmetic: this list goes into the system
 * prompt, the system prompt is the front of the cached prefix, and a prefix
 * whose bytes move between turns is a prefix that never gets a cache hit. An
 * order that came from whatever the asset listing happened to return would
 * break caching silently — the one failure mode `logUsage` exists to catch.
 *
 * Reading every SKILL.md to learn its description would be one asset read per
 * skill per turn, which is affordable at three skills and not at forty — and
 * "affordable at forty" is the entire argument for progressive disclosure. So
 * the built index is kept in `scriptStorage` under a fingerprint of the skill
 * files and their modification times: two reads per turn in the steady state,
 * and a rebuild exactly when a skill is added, edited or removed. The
 * fingerprint is stored alongside the index and compared in full, so a hash
 * collision costs a rebuild rather than serving a stale library.
 */
function loadSkills(): Skill[] {
  const files: AssetInfo[] = [];
  for (const asset of listAssetInfo()) {
    if (skillNameOf(asset.name) !== null) files.push(asset);
  }
  if (files.length === 0) return [];

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const capped = files.slice(0, MAX_SKILLS);

  const marks: string[] = [];
  for (const file of capped) {
    marks.push(file.name + "@" + String(file.updatedAt ?? 0));
  }
  const mark = marks.join(",");
  const key = "skills:" + shortHash(mark);

  try {
    const stored = scriptStorage.getItem(key);
    if (stored) {
      const entry = JSON.parse(stored) as { mark?: string; skills?: Skill[] };
      if (entry.mark === mark && Array.isArray(entry.skills)) {
        return entry.skills;
      }
    }
  } catch (e) {
    // A cache that cannot be read is one to rebuild, not to fail over.
  }

  const skills: Skill[] = [];
  for (const file of capped) {
    const name = skillNameOf(file.name);
    if (name === null) continue;
    const text = readAssetText(file.name);
    if (text === null) continue;
    skills.push({
      name: name,
      description: frontMatterValue(text, "description") || "(no description)",
    });
  }

  try {
    scriptStorage.setItem(key, JSON.stringify({ mark: mark, skills: skills }));
  } catch (e) {
    // Storing is an optimisation. Failing to store costs a rebuild next turn.
  }
  return skills;
}

/**
 * A short key for a long fingerprint (djb2).
 *
 * Not a security hash and not relied on for correctness — the full
 * fingerprint is stored in the entry and compared there. This only has to
 * spread keys well enough that one skill library does not sit on another's.
 */
function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** An asset's content as text, or null if it is not there. */
function readAssetText(name: string): string | null {
  // `fetchAsset` answers a missing asset with a sentence rather than by
  // failing, and that sentence is not base64 — so callers check the listing
  // first and only ask for names they have already seen.
  const encoded = assetStorage.fetchAsset(name);
  try {
    return convert.atob(encoded);
  } catch (e) {
    return null;
  }
}

/**
 * One `key: value` out of a leading `---` front-matter block.
 *
 * Deliberately not a YAML parser: the format's whole job here is to carry one
 * description line, and a parser that accepted more would be promising a
 * fidelity nothing downstream honours.
 */
function frontMatterValue(text: string, key: string): string {
  if (text.indexOf("---") !== 0) return "";
  const close = text.indexOf("\n---", 3);
  if (close === -1) return "";

  for (const line of text.slice(3, close).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== key) continue;

    let value = line.slice(colon + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"));
    if (quoted) value = value.slice(1, -1);
    return value;
  }
  return "";
}

/** What is left of a SKILL.md once the front matter is taken off. */
function skillBody(text: string): string {
  if (text.indexOf("---") !== 0) return text;
  const close = text.indexOf("\n---", 3);
  if (close === -1) return text;
  const lineEnd = text.indexOf("\n", close + 1);
  if (lineEnd === -1) return "";
  return text.slice(lineEnd + 1).replace(/^\n+/, "");
}

/**
 * The system prompt for a turn, with the skill index appended.
 *
 * Names and descriptions ride in the prompt while bodies are fetched on
 * demand, which is the whole of progressive disclosure: forty skills cost
 * forty lines until one of them is actually wanted. Putting the index here
 * rather than behind a `list_skills` tool is a deliberate trade — the model
 * has to be told that skills exist at all, and once the prompt is saying that
 * much, naming them costs a line each and saves a round trip out of the
 * twelve a run gets.
 *
 * A deployment with no skills gets the prompt it had before this existed,
 * byte for byte, and no extra tool.
 */
function systemPromptFor(skills: Skill[]): string {
  if (skills.length === 0) return SYSTEM_PROMPT;

  const lines = [
    SYSTEM_PROMPT,
    "",
    "Skills are instructions for particular kinds of work. When one covers " +
      "what you have been asked to do, call read_skill and follow it before " +
      "you start. Read at most the ones you need.",
    "",
  ];
  for (const skill of skills) {
    lines.push("- " + skill.name + ": " + skill.description);
  }
  return lines.join("\n");
}

// ============================================================================
// Tools
// ============================================================================

function runTool(
  userId: string,
  runId: string,
  name: string,
  input: Record<string, unknown>,
): { content: string; isError: boolean } {
  switch (name) {
    case "write_response": {
      const text = String(input.text ?? "");
      recordActivity(userId, runId, "response", text);
      return { content: "Delivered.", isError: false };
    }

    case "remember": {
      const key = String(input.key ?? "").trim();
      const value = String(input.value ?? "");
      if (!key) return { content: "A key is required.", isError: true };
      try {
        // Per (script, person), and only reachable while that person is the
        // one being served — which is exactly why this loop runs in their
        // request rather than in a background job.
        personalStorage.setItem(NOTE_PREFIX + key, value);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: message, isError: true };
      }
      recordActivity(userId, runId, "tool", `Remembered "${key}".`);
      return { content: "Stored.", isError: false };
    }

    case "recall": {
      const key = String(input.key ?? "").trim();
      if (!key) return { content: "A key is required.", isError: true };
      let value: string | null = null;
      try {
        value = personalStorage.getItem(NOTE_PREFIX + key);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: message, isError: true };
      }
      recordActivity(userId, runId, "tool", `Recalled "${key}".`);
      if (value === null) {
        // A miss names what would have worked. Guessing a key was the whole
        // reason memory was write-mostly, and a step spent learning "not that
        // one" teaches nothing on its own.
        return { content: missingNote(key), isError: false };
      }
      return { content: value, isError: false };
    }

    case "list_memories": {
      let listing: { memories: Memory[]; more: number };
      try {
        listing = listMemories();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: message, isError: true };
      }
      recordActivity(
        userId,
        runId,
        "tool",
        listing.memories.length === 1
          ? "Listed 1 note."
          : `Listed ${listing.memories.length} notes.`,
      );
      return { content: renderMemories(listing), isError: false };
    }

    case "run_js": {
      return runJsTool(userId, runId, String(input.source ?? ""));
    }

    case "read_skill": {
      return readSkillTool(
        String(input.name ?? "").trim(),
        String(input.file ?? "").trim() || SKILL_FILE,
      );
    }

    default:
      return { content: `No tool called "${name}".`, isError: true };
  }
}

/**
 * Hand the model a skill's instructions.
 *
 * Every refusal names what would have worked. An error is the one piece of
 * text the model is guaranteed to read closely, so "no such skill; these
 * exist" turns a wasted step into a recovered one, where a bare "not found"
 * spends the step and teaches nothing.
 */
function readSkillTool(
  name: string,
  file: string,
): { content: string; isError: boolean } {
  const skills = loadSkills();
  const known = skills.map((s) => s.name);

  if (!name) {
    return {
      content: `A skill name is required. These exist: ${known.join(", ")}.`,
      isError: true,
    };
  }

  // Matched case-insensitively, since the model is copying a name out of prose.
  let resolved = "";
  for (const candidate of known) {
    if (candidate.toLowerCase() === name.toLowerCase()) resolved = candidate;
  }
  if (!resolved) {
    return {
      content: `No skill called "${name}". These exist: ${known.join(", ")}.`,
      isError: true,
    };
  }

  // A skill may only offer its own folder. The listing check below would
  // refuse an escape anyway — nothing outside this script's assets is in it —
  // but a traversal is worth naming rather than reporting as "not found".
  if (file.indexOf("..") !== -1 || file.indexOf("/") === 0) {
    return {
      content: `"${file}" is not a file inside a skill.`,
      isError: true,
    };
  }

  const assetName = SKILLS_PREFIX + resolved + "/" + file;
  const siblings: string[] = [];
  const folder = SKILLS_PREFIX + resolved + "/";
  let exists = false;
  for (const asset of listAssetInfo()) {
    if (asset.name === assetName) exists = true;
    if (asset.name.indexOf(folder) === 0) {
      siblings.push(asset.name.slice(folder.length));
    }
  }
  if (!exists) {
    return {
      content: `"${resolved}" has no file "${file}". It has: ${siblings.join(", ")}.`,
      isError: true,
    };
  }

  const text = readAssetText(assetName);
  if (text === null) {
    return { content: `"${file}" could not be read.`, isError: true };
  }

  const content = file === SKILL_FILE ? skillBody(text) : text;
  if (content.length > MAX_SKILL_CHARS) {
    return {
      content:
        content.slice(0, MAX_SKILL_CHARS) +
        `\n\n[cut here: "${file}" is longer than ${MAX_SKILL_CHARS} characters]`,
      isError: false,
    };
  }
  return { content: content, isError: false };
}

/**
 * Run the code the model wrote, in a context holding less than this one.
 *
 * The three things this function is arranged around:
 *
 * **The person sees the code before it runs.** An agent executing something
 * nobody was shown is the thing people object to, and rightly. The activity is
 * recorded first, so the source is on the page for however long the code takes
 * rather than arriving with its result.
 *
 * **A thrown error and a returned one mean different things**, and the engine
 * draws the line where an agent needs it. `sandbox.run` throws when the
 * *request* was wrong — a capability that is not one, one this turn does not
 * hold, nesting too deep — which is a bug in this file and belongs in the log.
 * It *returns* with `ok: false` when the *code* was wrong, and that is the
 * result of the turn: it goes back to the model as the next observation,
 * because code that did not work is what the model is there to fix.
 *
 * **The helpers are visible and it does not matter.** The source is evaluated
 * after this script's own program and in the same realm, so it can see
 * `finishRun`, `appendMessage`, `callModel` and the rest. Every one of them
 * bottoms out in a capability the sub-execution was not given — the database
 * writes, the storage writes, the `{{secret:...}}` substitution that makes a
 * model call possible — so what it can reach is decided by the list above and
 * not by what happens to be in scope. That is the property a mask over the
 * running context could not have given: the two executions share no object
 * graph, so this turn cannot hand the narrowed one a function and have it
 * called.
 */
function runJsTool(
  userId: string,
  runId: string,
  source: string,
): { content: string; isError: boolean } {
  if (!source.trim()) {
    return {
      content: "There was no code to run. Put the code in `source`.",
      isError: true,
    };
  }

  const granted = codeCapabilities();

  recordActivity(userId, runId, "code", cut(source.trim(), CODE_ECHO_CHARS));

  let result: SandboxResult;
  try {
    result = sandbox.run(source, {
      capabilities: granted,
      timeoutMs: CODE_TIMEOUT_MS,
    });
  } catch (e) {
    // The request was wrong rather than the code. Logged rather than dressed
    // up as a result, because the model cannot fix it and should not be asked
    // to try: the next turn would rewrite working code to appease a refusal
    // that had nothing to do with it.
    const message = e instanceof Error ? e.message : String(e);
    console.log("agent: could not start a sub-execution: " + message);
    return {
      content: `The code could not be run at all: ${message}. This is a fault in the agent rather than in your code.`,
      isError: true,
    };
  }

  return renderCodeResult(result, granted);
}

/**
 * What `run_js` may actually be given, which is what it wants and this turn
 * holds.
 *
 * A grant can be narrower than `CODE_CAPABILITIES` — a delegation that said
 * read and not write is still allowed to be one — and `sandbox.run` throws
 * when asked to keep something the caller does not have. So the list is a
 * request rather than an assertion, and an empty intersection still runs: code
 * holding nothing at all computes, which is the base case everything else is
 * subtracted from.
 */
function codeCapabilities(): Capability[] {
  let held: Capability[] = [];
  try {
    held = sandbox.held();
  } catch (e) {
    // Nothing to do but grant nothing. Code that can only compute is worth
    // more than a tool that refuses.
    console.log("agent: could not read what this turn holds: " + String(e));
    return [];
  }
  return CODE_CAPABILITIES.filter((name) => held.indexOf(name) !== -1);
}

/**
 * Turn one sub-execution into the thing the model reads next.
 *
 * Every branch here is a prompt. A tool result is the one piece of text a
 * model reads closely, so a failure that says what would have worked turns a
 * dead step into a recovered one, where a bare "it failed" spends the step and
 * teaches nothing — and a run gets twelve.
 *
 * Two of them are worth the trouble. A refusal from the engine already names
 * the capability it wanted and says *narrowed* when the reason was this rather
 * than the caller's own tier, so the message is kept as it came (minus the
 * engine's own stack frames) and the list of what the code does hold is added
 * beneath it. And code that returned `undefined` having printed nothing is
 * nearly always the same mistake — a body of statements with no trailing
 * expression — which is cheap to say and expensive to let the model discover
 * by writing it twice.
 *
 * One thing worth knowing before trusting `ok` as "nothing was refused": it is
 * not. A refusal reaches the code in whichever way that API already reports
 * failure, and `database` reports it by answering `{ error }` rather than by
 * throwing — so a narrowed `database.query` comes back as a *successful* run
 * whose value happens to be a refusal. Nothing here needs to special-case
 * that, because the engine's message names the capability either way, but a
 * reader adding a branch on `ok` should not assume it catches every refusal.
 */
function renderCodeResult(
  result: SandboxResult,
  granted: Capability[],
): { content: string; isError: boolean } {
  const parts: string[] = [];
  const printed = consoleBlock(result);

  if (!result.ok) {
    parts.push("The code failed: " + tidyError(result.error ?? ""));
  }
  if (printed) {
    parts.push(printed);
  }
  if (result.ok) {
    parts.push(valueBlock(result, printed !== ""));
  } else {
    parts.push(
      granted.length > 0
        ? "This code runs holding only: " +
            granted.join(", ") +
            ". It cannot write anything, read a secret, or query the database — use remember to store something and write_response to say something."
        : "This code runs holding no capabilities at all, so it can compute and nothing else.",
    );
  }

  return {
    content: cut(parts.join("\n\n"), MAX_CODE_RESULT_CHARS),
    isError: !result.ok,
  };
}

/**
 * The failure, with the engine's own stack frames taken out.
 *
 * A refusal arrives as a message followed by a QuickJS stack, and most of that
 * stack is inside the preludes the engine installs — `engine://fetch-prelude`,
 * `engine://storage-prelude`. Those frames locate nothing the model wrote, and
 * a tool result is not paid for once: it is stored in the conversation and
 * resent on every turn after it, so noise here is bought twelve times over.
 *
 * The frames that name the model's own source are kept, because an error in
 * the middle of thirty lines is worth being able to find.
 */
function tidyError(error: string): string {
  const parts = error.split("\nStack:");
  // rquickjs punctuates the message with a trailing comma before the stack.
  const message = parts[0].trim().replace(/,$/, "");
  if (parts.length < 2) return message || "no reason given";

  const frames: string[] = [];
  for (const line of parts[1].split("\n")) {
    const frame = line.trim();
    if (!frame || frame.indexOf("engine://") !== -1) continue;
    if (frames.length >= MAX_CODE_STACK_FRAMES) break;
    frames.push("  " + frame);
  }
  if (frames.length === 0) return message || "no reason given";
  return (message || "no reason given") + "\n" + frames.join("\n");
}

/** What the code evaluated to, or why there is nothing to show. */
function valueBlock(result: SandboxResult, printedSomething: boolean): string {
  const type = result.valueType ?? "undefined";

  if (type === "undefined" || type === "function" || type === "symbol") {
    if (printedSomething) {
      return `It returned nothing (${type}), so the output above is all there is.`;
    }
    return (
      `It ran, printed nothing and returned nothing (${type}). The value of ` +
      "the last expression is what comes back — `const x = 1;` returns " +
      "undefined where `const x = 1; x` returns 1. End with the expression " +
      "you want, or console.log along the way."
    );
  }

  // Whatever comes back has already been through `JSON.stringify` and reparsed
  // engine-side, so it has a JSON form by construction — anything that did not
  // was reported as `undefined` by `valueType` and handled above.
  const rendered = JSON.stringify(result.value, null, 2);
  return `Returned (${type}):\n${cut(rendered, MAX_CODE_VALUE_CHARS)}`;
}

/** What the code printed, whether or not it worked. */
function consoleBlock(result: SandboxResult): string {
  const lines = result.console ?? [];
  const overflow = Math.max(0, lines.length - MAX_CODE_CONSOLE_LINES);
  const dropped = (result.consoleDropped ?? 0) + overflow;
  if (lines.length === 0 && dropped === 0) return "";

  const shown: string[] = [];
  for (const line of lines.slice(0, MAX_CODE_CONSOLE_LINES)) {
    shown.push("  " + cut(String(line.message ?? ""), MAX_CODE_LINE_CHARS));
  }
  // The oldest lines are kept rather than the newest: the first thing a run
  // printed is usually what it was about to do, and the last is whatever it
  // was doing when it ran out of room.
  if (dropped > 0) {
    shown.push(`  [cut here: ${dropped} more lines]`);
  }
  return "Printed:\n" + shown.join("\n");
}

/** Text with a ceiling, saying so rather than ending mid-word in silence. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + ` [cut here: ${text.length - max} more]`;
}

// ============================================================================
// Storage
// ============================================================================

function appendMessage(
  userId: string,
  runId: string,
  speaker: "user" | "assistant",
  blocks: ContentBlock[],
): void {
  must(
    database.insert(
      "messages",
      JSON.stringify({
        user_id: userId,
        run_id: runId,
        speaker: speaker,
        blocks: JSON.stringify(blocks),
        created_ms: Date.now(),
      }),
    ),
    "storing a message",
  );
}

/**
 * A run's messages in the order they were written.
 *
 * Ordered by `id` rather than `created_ms`: two rows written in the same
 * millisecond tie on the timestamp, and a conversation replayed out of order
 * is a different conversation.
 *
 * Ascending with a limit takes the *oldest* rows, which is what makes the
 * ceiling detectable rather than silent. Reading `MAX_HISTORY_ROWS` exactly
 * meant a run past the ceiling went on being served its first sixty rows
 * forever: the newest turn — the tool results the model was waiting on — fell
 * outside the read, so every turn after that resent an identical prefix and
 * the run reasoned about a conversation that had stopped moving. Nothing
 * failed; it just could not finish, and `maxAttempts: 1` meant nothing
 * retried it into view either.
 *
 * One row past the ceiling is enough to tell "at the limit" from "over it",
 * which is the distinction the caller acts on.
 */
function loadMessages(userId: string, runId: string): MessageRow[] {
  return queryRows(
    "messages",
    JSON.stringify({ user_id: userId, run_id: runId }),
    MAX_HISTORY_ROWS + 1,
    "id",
    "asc",
  ) as MessageRow[];
}

function toApiMessage(row: MessageRow): ApiMessage {
  return {
    role: row.speaker === "assistant" ? "assistant" : "user",
    content: JSON.parse(row.blocks) as ContentBlock[],
  };
}

/**
 * Records something the person should see, and pushes it to their open tabs.
 *
 * Stored first: the stream is a convenience, the table is the record. A page
 * reopened tomorrow reads the table and misses nothing.
 */
function recordActivity(
  userId: string,
  runId: string,
  kind: string,
  message: string,
): void {
  const at = Date.now();
  must(
    database.insert(
      "activities",
      JSON.stringify({
        user_id: userId,
        run_id: runId,
        kind: kind,
        message: message,
        created_ms: at,
      }),
    ),
    "storing an activity",
  );
  routeRegistry.sendStreamMessageFiltered(
    STREAM_PATH,
    { runId: runId, kind: kind, message: message, at: at },
    JSON.stringify({ userId: userId }),
    "subset",
  );
}

// ============================================================================
// Small helpers
// ============================================================================

function signedInUser(context: HandlerContext): string | null {
  const auth = context.request?.auth;
  if (!auth || !auth.isAuthenticated || !auth.userId) return null;
  return auth.userId;
}

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function json(status: number, body: unknown): HttpResponse {
  return {
    status: status,
    body: JSON.stringify(body),
    contentType: "application/json; charset=utf-8",
  };
}
