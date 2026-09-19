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

/** Assistant turns one run may take before the script stops it. */
const MAX_STEPS = 12;

const STREAM_PATH = "/agent/events";

/**
 * Rows one run may accumulate; also the history window sent to the model.
 *
 * Every turn resends the run so far, so this bounds both the time a step
 * spends and what it costs. A run reaching it is one `MAX_STEPS` should have
 * stopped long before.
 */
const MAX_HISTORY_ROWS = 60;

const SYSTEM_PROMPT = [
  "You are an assistant embedded in a web page.",
  "The person cannot see your reasoning or your raw output — they only see what",
  "you send with the write_response tool. Always finish a task by calling",
  "write_response, even when the answer is short or the news is bad.",
  "Use remember and recall for anything worth keeping between runs.",
].join(" ");

// ============================================================================
// The model's tools
// ============================================================================

/**
 * `strict: true` needs `additionalProperties: false` and `required`, and buys
 * arguments that are guaranteed to match the schema — worth having when the
 * handler below trusts the shape.
 */
const TOOLS = [
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
];

// ============================================================================
// Shapes
// ============================================================================

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

  routeRegistry.registerAssetRoute("/agent", "ui.html");
  routeRegistry.registerAssetRoute("/agent/app.js", "app.js");

  routeRegistry.registerRoute("/agent/prompt", "startRun", "POST", {
    tags: ["Agent"],
    summary: "Accept a prompt and open a run",
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
    personalTasks.enqueue({
      handler: "advanceRun",
      payload: { runId: runId },
      maxAttempts: 1,
    });
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

  const history = loadMessages(userId, runId);
  if (history.length === 0) {
    console.log(`agent: no such run ${runId}`);
    return;
  }

  const taken = history.filter((m) => m.speaker === "assistant").length;
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

  let answer: ApiResponse;
  try {
    answer = callModel(history.map(toApiMessage));
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

  const results: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      // The model is asked to speak through write_response; plain text is
      // shown anyway rather than silently dropped.
      recordActivity(userId, runId, "note", block.text);
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

  if (results.length > 0) {
    // Every result in one user message: splitting them teaches the model to
    // stop calling tools in parallel.
    appendMessage(userId, runId, "user", results);

    // The next turn, queued rather than run here — same reasoning as the
    // first: one model call per execution budget. Enqueueing is what replaced
    // the browser posting the next step.
    try {
      personalTasks.enqueue({
        handler: "advanceRun",
        payload: { runId: runId },
        maxAttempts: 1,
      });
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
 * Tell the person's open tabs that the run is over.
 *
 * The page used to learn this from the step response it was waiting on. It no
 * longer waits on anything, so the end of a run has to arrive the same way
 * everything else does.
 */
function finishRun(userId: string, runId: string, reason: string): void {
  recordActivity(userId, runId, "done", reason);
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
  return json(200, {
    activities: ordered.map((row) => ({
      runId: row.run_id,
      kind: row.kind,
      message: row.message,
      at: Number(row.created_ms),
    })),
    hasKey: secretStorage.exists(SECRET_NAME),
    authorization: personalTasks.authorization(),
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
 * One request to the Messages API.
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
 */
function callModel(messages: ApiMessage[]): ApiResponse {
  const response = fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": "{{secret:" + SECRET_NAME + "}}",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: messages,
      tools: TOOLS,
      // No `output_config.effort` and no `thinking`: this model rejects the
      // first and does not take the adaptive form of the second. Both come
      // back if the model moves up a tier.
    }),
  });

  if (!response.ok) {
    const detail = readErrorMessage(response.body);
    throw new Error(`The model API answered ${response.status}: ${detail}`);
  }

  return response.json() as ApiResponse;
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
        personalStorage.setItem("note:" + key, value);
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
        value = personalStorage.getItem("note:" + key);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: message, isError: true };
      }
      recordActivity(userId, runId, "tool", `Recalled "${key}".`);
      if (value === null) {
        return { content: `Nothing is stored under "${key}".`, isError: false };
      }
      return { content: value, isError: false };
    }

    default:
      return { content: `No tool called "${name}".`, isError: true };
  }
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
 */
function loadMessages(userId: string, runId: string): MessageRow[] {
  const rows = must(
    database.query(
      "messages",
      JSON.stringify({ user_id: userId, run_id: runId }),
      MAX_HISTORY_ROWS,
      "id",
      "asc",
    ),
    "reading a run",
  ) as MessageRow[];
  return Array.isArray(rows) ? rows : [];
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
