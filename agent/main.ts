/// <reference path="../types/aiwebengine.d.ts" />

/**
 * A prompt-driven agent that runs inside aiwebengine.
 *
 * The loop is driven by the browser, one HTTP request per turn, because the
 * engine gives no other place to run it:
 *
 * - `schedulerService.registerOnce` only registers during `init()`, so a
 *   handler cannot schedule its own continuation.
 * - A scheduled job runs as `UserContext::admin("scheduler")`, and `fetch`
 *   resolves `{{secret:...}}` against the *calling* user. A background job
 *   therefore cannot reach the person's own API key — it would look for a
 *   secret belonging to a user called `scheduler`.
 * - `dispatcher.sendMessage` runs its listeners inline, on the sender's budget.
 *
 * So each turn is a separate `POST /agent/step` under that person's session:
 * their identity is present (their key is reachable, `personalStorage` works),
 * and each turn gets a fresh `javascript.execution_timeout_ms` instead of
 * several turns sharing one. The page posts steps until the run reports done.
 */

// ============================================================================
// Configuration
// ============================================================================

/**
 * The model every run uses.
 *
 * Haiku for now, on cost: an agent turn resends the whole conversation, so the
 * bill grows with the length of a run rather than with the prompt. It also
 * suits the 10-second budget, being the fastest of the family.
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
 * One turn's output ceiling. Small on purpose: the whole step has to finish
 * inside `javascript.execution_timeout_ms` (10s by default), `fetch` is
 * synchronous, and its timeout is clamped to whatever is left of that budget.
 * Raise this only alongside the engine's execution timeout.
 */
const MAX_TOKENS = 2048;

/** Assistant turns one run may take before the script stops it. */
const MAX_STEPS = 12;

const STREAM_PATH = "/agent/events";

/** Rows one run may accumulate; also the history window sent to the model. */
const MAX_HISTORY_ROWS = 200;

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
  role: string;
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

function init(): void {
  database.ensureTable(
    "messages",
    JSON.stringify({
      columns: [
        { name: "user_id", type: "text" },
        { name: "run_id", type: "text" },
        { name: "role", type: "text" },
        { name: "blocks", type: "text" },
        { name: "created_ms", type: "bigint" },
      ],
    }),
  );

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
  );

  routeRegistry.registerAssetRoute("/agent", "ui.html");
  routeRegistry.registerAssetRoute("/agent/app.js", "app.js");

  routeRegistry.registerRoute("/agent/prompt", "startRun", "POST", {
    tags: ["Agent"],
    summary: "Accept a prompt and open a run",
  });
  routeRegistry.registerRoute("/agent/step", "runStep", "POST", {
    tags: ["Agent"],
    summary: "Advance one run by a single turn",
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

  const runId = newRunId();
  appendMessage(userId, runId, "user", [{ type: "text", text: prompt }]);
  recordActivity(userId, runId, "prompt", prompt);

  return json(200, { runId });
}

/**
 * One turn: read the run, ask the model once, run whatever tools it named.
 *
 * Returns `done` rather than looping, because looping here would spend one
 * execution budget on several model calls and hit the ceiling mid-run. The
 * page calls this again while `done` is false.
 */
function runStep(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let runId = "";
  try {
    const body = (context.request?.json() ?? {}) as { runId?: string };
    runId = String(body.runId ?? "");
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!runId) return json(400, { error: "A runId is required." });

  const history = loadMessages(userId, runId);
  if (history.length === 0) {
    return json(404, { error: "No such run." });
  }

  const taken = history.filter((m) => m.role === "assistant").length;
  if (taken >= MAX_STEPS) {
    recordActivity(
      userId,
      runId,
      "error",
      `Stopped after ${MAX_STEPS} turns without finishing.`,
    );
    return json(200, { done: true, reason: "step-limit" });
  }

  let answer: ApiResponse;
  try {
    answer = callModel(history.map(toApiMessage));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordActivity(userId, runId, "error", message);
    return json(200, { done: true, reason: "error", error: message });
  }

  // A refusal is an HTTP 200 with no usable content, so this has to be read
  // before `content` is touched. This model tier does not produce one, but the
  // branch is what makes moving up a tier a one-line change.
  if (answer.stop_reason === "refusal") {
    const why = answer.stop_details?.explanation ?? "The model declined.";
    recordActivity(userId, runId, "error", why);
    return json(200, { done: true, reason: "refusal" });
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
    return json(200, { done: false });
  }

  return json(200, { done: true, reason: answer.stop_reason ?? "end_turn" });
}

function readHistory(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  const rows = database
    .query(
      "activities",
      JSON.stringify({ user_id: userId }),
      MAX_HISTORY_ROWS,
      "id",
      "desc",
    )
    .json() as ActivityRow[];

  const ordered = Array.isArray(rows) ? rows.slice().reverse() : [];
  return json(200, {
    activities: ordered.map((row) => ({
      runId: row.run_id,
      kind: row.kind,
      message: row.message,
      at: Number(row.created_ms),
    })),
    hasKey: secretStorage.exists(SECRET_NAME),
  });
}

function readKeyStatus(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });
  return json(200, { hasKey: secretStorage.exists(SECRET_NAME) });
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
 * The key is never in this process. `x-api-key` is the whole-value secret
 * template the engine substitutes host-side — and whole-value is the only form
 * it understands, which is why a `Authorization: Bearer {{secret:...}}` header
 * would be sent literally.
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
  role: "user" | "assistant",
  blocks: ContentBlock[],
): void {
  database.insert(
    "messages",
    JSON.stringify({
      user_id: userId,
      run_id: runId,
      role: role,
      blocks: JSON.stringify(blocks),
      created_ms: Date.now(),
    }),
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
  const rows = database
    .query(
      "messages",
      JSON.stringify({ user_id: userId, run_id: runId }),
      MAX_HISTORY_ROWS,
      "id",
      "asc",
    )
    .json() as MessageRow[];
  return Array.isArray(rows) ? rows : [];
}

function toApiMessage(row: MessageRow): ApiMessage {
  return {
    role: row.role === "assistant" ? "assistant" : "user",
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
  database.insert(
    "activities",
    JSON.stringify({
      user_id: userId,
      run_id: runId,
      kind: kind,
      message: message,
      created_ms: at,
    }),
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
