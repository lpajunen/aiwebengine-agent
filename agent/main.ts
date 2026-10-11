/// <reference path="../types/aiwebengine.d.ts" />

import {
  frameData,
  jsonStringPrefix,
  proseKindFor,
  readErrorMessage,
} from "./protocol.ts";
import {
  wantedCapabilities,
  withoutTheExfiltrationPair,
} from "./capabilities.ts";
import {
  COMPACT_AT_ROWS,
  COMPACT_AT_TOKENS,
  emptySpend,
  HISTORY_QUERY_LIMIT,
  MAX_HISTORY_ROWS,
  overHistoryLimit,
  shouldCompact,
  spendLine,
  spendOf,
  stepsSincePrompt,
} from "./budget.ts";
import {
  SKILLS_PREFIX,
  SKILL_FILE,
  SKILL_NAME_PATTERN,
  frontMatterValue,
  renderSkillFile,
  shortHash,
  skillAssetPath,
  skillBody,
  skillNameOf,
} from "./skills.ts";
import { onlyReads, parseArgs } from "./engine.ts";
import {
  MAX_OWN_INSTRUCTIONS_CHARS,
  MAX_SHARED_INSTRUCTIONS_CHARS,
  PromptPart,
  SHARED_INSTRUCTIONS_FILE,
  SentPrompt,
  instructionParts,
  joinParts,
  ownInstructionsProblem,
  requestMark,
  sentPromptOf,
  tidyInstructions,
} from "./context.ts";
import {
  AUTHOR_PROMPT,
  AUTHOR_TOOLS,
  INSTRUCTIONS_PLACEHOLDER,
  ESCALATE_AT,
  MAX_NUDGES,
  MOST_STEPS,
  NUDGE,
  STUB_SOURCE,
  clip,
  failureSignature,
  handoffNote,
  cancelTaskArgs,
  evalScriptArgs,
  gitPush,
  gitPushFrom,
  gitPushText,
  pushToGitArgs,
  secretChange,
  secretChangeFrom,
  secretPlanText,
  isAuthorTool,
  revertScriptArgs,
  notOpenable,
  isShape,
  leftoverPlaceholders,
  looseEdit,
  nearestRegion,
  maxStepsFor,
  maxTokensFor,
  nextFailureCount,
  readFilesArgument,
  readRemoveArgument,
  repairEscapedSource,
  runKindOf,
  scriptNameProblem,
  shouldEscalate,
  summariseCheck,
  summariseTests,
  templateScriptFor,
  testsPassed,
} from "./authoring.ts";
import { rememberArgs, skillWriteArgs } from "./plans.ts";
import {
  Attachment,
  AttachmentDetail,
  MAX_ATTACHMENTS,
  attachmentKind,
  describeAttachments,
  originalNames,
  parseDetail,
  previewOf,
  promptBlocks,
  refusedAttachments,
  refusedName,
  TelegramFile,
  telegramFiles,
  tooLargeToRead,
  withoutRefused,
} from "./attachments.ts";
import { renderSvg, telegramPhotoForm } from "./images.ts";
import {
  menuCommands,
  parseCommand,
  skillPrompt,
  telegramCommands,
} from "./commands.ts";
import { Route, routeMessage } from "./telegram.ts";
import {
  CONVERSATIONS_PER_PAGE,
  CONVERSATION_TABLES,
  conversationTitle,
  legacyRuns,
  pageOf,
} from "./conversations.ts";

/**
 * A prompt-driven agent that runs inside aiwebengine.
 *
 * The run lives in the engine. `POST /agent/prompt` queues the first turn and
 * answers; each turn queues the next; the page watches the SSE stream. Closing
 * the tab does not stop anything.
 *
 * Turns run on `personalTasks`: a durable queue whose work runs *as the person
 * who asked for it*, so their key resolves and `personalStorage` answers.
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
 * here passes `maxAttempts: 1` and lets the run's step ceiling do the bounding.
 *
 * The answer arrives as it is written. `callModel` reads the model's response
 * with `fetchStream` and pushes the text on as it becomes readable, so the
 * page fills in rather than waiting out the whole turn in silence. Only the
 * stream carries the pieces: the tables are still written once, by the tool
 * that produced the text, so nothing about reopening the page later changes.
 *
 * And the prompt is cached, which is what makes resending the run every turn
 * affordable — though not until a run passes 512 tokens, this model's minimum
 * cacheable prefix. See the request body in `callModel`, and `logUsage` for
 * the evidence that it is working.
 */

// ============================================================================
// Configuration
// ============================================================================

/**
 * The model every run uses.
 *
 * Haiku on cost: an agent turn resends the whole conversation, so the bill
 * grows with the length of a run rather than with the prompt. A turn is a job
 * with `javascript.job_timeout_ms`, so speed does not decide this.
 *
 * Changing this is not only the string. Haiku 5.5 takes thinking as
 * `{type: "adaptive"}` with `output_config.effort`, rejects sampling
 * parameters and assistant prefill, and has no server-side refusal fallback —
 * that belongs to the Opus / Fable tier.
 */
const MODEL = "claude-haiku-5-5";

/**
 * How much the model thinks. Thinking counts toward `max_tokens`, so this and
 * the ceilings in `authoring.ts` are chosen together. `medium` is the model's
 * own default, set explicitly so a change of default does not change the bill.
 */
const EFFORT = "medium";

/**
 * Thinking blocks are bound to everything sent before them: a request that
 * replays one after `system` or `tools` has changed is a 400 on accounts made
 * since 2026-08-31. This run changes both on purpose — approving a plan swaps
 * the tools and the system prompt, and the summariser has its own system
 * prompt — so mismatched blocks are dropped by the API instead of failing the
 * turn. A dropped block is not billed; the model only loses its earlier
 * reasoning.
 */
const BETA_HEADER = "thinking-binding-controls-2026-08-01";

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
 * These are the rates for a prompt up to 100,000 tokens; the model charges
 * more above that. A run never gets there — `COMPACT_AT_TOKENS` folds the
 * conversation up at 30,000 — so the dearer tier is not modelled.
 *
 * The cache rates are the model's own, not multiples of the input rate: a
 * cache read is a tenth of it and a 5-minute cache write a quarter more.
 */
const PRICES = {
  freshPerM: 0.1,
  cacheWritePerM: 0.125,
  cacheReadPerM: 0.01,
  outputPerM: 0.5,
};

/** What the model can hold, for the meter on the page. */
const CONTEXT_WINDOW = 1000000;

const API_URL = "https://api.anthropic.com/v1/messages";
const FILES_URL = "https://api.anthropic.com/v1/files";

/**
 * Where each person's own API key lives: `user_secrets`, keyed by
 * (script, user, name). The engine never hands the value back to JavaScript —
 * `secretStorage` can only say whether it exists — so the only way to use it
 * is the `{{secret:...}}` header template, resolved host-side for the calling
 * user. This script cannot read, log or forward anybody's key.
 */
const SECRET_NAME = "ANTHROPIC_API_KEY";

/**
 * Output and turn ceilings are per kind of run — see `authoring.ts`. A chat
 * run keeps the small ones; a run that builds a script gets room to write
 * several files, and needs the job budget raised to match:
 *
 *     set_script_limits script=<this script> jobTimeoutMs=120000
 *
 * `fetch` is still synchronous and its timeout still clamped to what is left
 * of the budget, so generation remains the part that scales with the token
 * ceiling.
 */

/**
 * How long one model call may take.
 *
 * Passed explicitly, and that is the whole of the fix it represents. A `fetch`
 * given no `timeout` uses the engine's default of **30 seconds**, and the
 * budget clamp takes the *minimum* of that and what the execution has left —
 * so the job budget could never raise it. Every model call this agent has ever
 * made has had a 30-second ceiling, whatever `job_timeout_ms` said.
 *
 * Which was invisible while answers were short and became a wall as soon as
 * one turn had something long to write: a whole `SKILL.md` body is close to
 * the token ceiling, and on this tier that does not reliably finish inside thirty
 * seconds. It surfaced as `fetchStream ... Request timed out` on exactly the
 * turns that were doing the most work, which reads like a network fault and
 * is not one.
 *
 * Still clamped by the execution budget, so this is a ceiling rather than a
 * grant: a run gets `min(this, what the job has left)`. It is set below
 * `javascript.job_timeout_ms` on purpose — the turn still has to store what
 * came back and queue its successor after the stream ends, and a timeout that
 * used the whole budget would leave nothing for that.
 *
 * Raising it past the engine's job budget does nothing on its own; that is
 * `set_script_limits jobTimeoutMs=...`, which is the dial to turn first.
 */
const MODEL_TIMEOUT_MS = 110000;

const STREAM_PATH = "/agent/events";

/** Asides delivered to one turn. Beyond this they wait for the next. */
const MAX_INTERJECTIONS = 10;

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
  "you say. A turn that calls only write_response ends the run — so if you mean",
  "to say something and keep working, call the tool you need next in the same",
  "turn. Always answer, even",
  "when the answer is short or the news is bad. If you end a turn with plain",
  "text and no tool call, that text is delivered as your answer and the run",
  "ends there — so never end a turn having said nothing at all.",
  "When a picture would explain better than words — a diagram, a chart —",
  "draw it as SVG with write_image, then answer with write_response.",
  "Use remember for anything worth keeping between runs, list_memories to see",
  "what you already know about this person, and recall to read one back.",
  "When the work is more than one step — fetching something, trying each of",
  "several things, shaping data before you can answer — write it as code and",
  "call run_js. One call does what a tool call each would have taken a turn",
  "apiece to do, and you have twelve turns.",
].join(" ");

/**
 * Added only when the management tools are on the list.
 *
 * Kept out of [`SYSTEM_PROMPT`] rather than written conditionally into it,
 * because most runs have no management authority and a paragraph about tools
 * that are not there is a paragraph the model has to rule out on every turn.
 * It joins the prefix in [`systemPartsFor`], where the tool list is decided,
 * so the two never disagree about whether these exist.
 */
const ENGINE_PROMPT = [
  "This engine's own management tools are available to you: scripts, assets,",
  "users, secrets, logs, revisions and deployments. Call engine_tools to find",
  "the one you want and engine_call to use it — do not guess a name, the list",
  "is what this deployment actually serves.",
  "You are acting as the person whose run this is, with what they granted, so",
  "a refusal means their account may not do it. Report that rather than trying",
  "another way round.",
  "Reads answer straight away; anything that changes something needs",
  "request_approval first.",
].join(" ");

const APP_PROMPT = [
  "The person's own apps on this engine publish tools you can use as them:",
  "call app_tools to see what there is and app_call to use one. When they ask",
  "about something one of their apps keeps — a backlog, a list, a record —",
  "look there before saying you do not know.",
  "Until a plan is approved an app tool runs read-only, so one that changes",
  "something is refused: propose the change with request_approval instead.",
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
 * How much of a note the person is shown, and may edit, in one field.
 *
 * Generous, because a note is the person's own and a preview is what the
 * *model* gets. The cap exists for the two ends of the range rather than the
 * middle: a hundred notes of unbounded length is a page load nobody wants,
 * and — the reason it is enforced rather than merely applied — a field
 * showing part of a note would save back part of a note. A value over this
 * is sent marked, and the page will not let it be edited.
 */
const MAX_MEMORY_VALUE_CHARS = 4000;

/**
 * A note as its owner sees it: the whole thing, not a preview.
 *
 * The distinction from [`Memory`] is the entire point of this endpoint.
 * `list_memories` exists so the *model* can find a key worth reading, so it
 * carries a first line and a length. A person is not searching an index —
 * they are checking whether what the agent believes about them is true, and a
 * preview cannot answer that.
 */
interface MemoryView {
  key: string;
  value: string;
  chars: number;
  /** The value is longer than the field can safely round-trip. */
  truncated: boolean;
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
  run_mode?: string;
  channel?: string;
  chat_id?: string;
  task_id: string;
  steps?: number;
  run_kind?: string;
  fail_sig?: string;
  nudges?: number;
  step_base?: number;
  title?: string;
  shared_instr?: string;
  own_instr?: string;
  created_ms?: number;
  updated_ms?: number;
}

/** The deployment's instructions and the person's, as one prompt froze them. */
interface Instructions {
  shared: string;
  own: string;
}

/** A plan put to the person, before and after they answer it. */
interface PlanRow {
  id: number;
  run_id: string;
  body: string;
  decision: string;
  note?: string;
  /** The tool call this plan defers, if it defers one. */
  action?: string;
  payload?: string;
  created_ms: number;
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

/**
 * How many skills the index will name.
 *
 * The index is the part that costs tokens on every single turn, so it is the
 * part with a ceiling. Bodies are read on demand and are not bounded by this.
 */
const MAX_SKILLS = 64;

/** A skill body handed to the model, in characters. */
const MAX_SKILL_CHARS = 32000;

/** A description sits in the prompt on every turn, so it stays one line. */
const MAX_SKILL_DESCRIPTION_CHARS = 200;

interface Skill {
  name: string;
  description: string;
}

// ============================================================================
// Code as the action
// ============================================================================

/**
 * What a run may do, as a name rather than a flag.
 *
 * Two values, deliberately stored as a string. What actually varies between
 * harnesses that ship this is *how often a person is asked* — plan,
 * auto-accept, unattended — which is a scale rather than a switch, and every
 * one of them that started with a boolean has had to re-litigate it on the
 * next tool added. A third rung here is a row value and a branch in
 * [`capabilitiesFor`], not a schema change and not a rewrite of this type.
 *
 * `plan` is the floor and the default, so a run that never needs to write is
 * never interrupted: everything readable is already in [`PLAN_CAPABILITIES`],
 * and only writing has to be asked for.
 */
type RunMode = "plan" | "act";
type RunKind = "chat" | "author";

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

/**
 * The most of an engine tool's answer to put in front of the model.
 *
 * A listing is the shape that runs away: `list_users` on a real deployment, or
 * `read_logs` without a narrow filter, is thousands of rows the model will
 * summarise into one sentence. Cutting it costs that sentence some accuracy
 * and saves a turn's budget; not cutting it costs the run.
 */
const MAX_ENGINE_RESULT_CHARS = 4000;

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
    name: "write_image",
    description:
      "Show the person a picture you draw as SVG: a diagram, a chart, a sketch. It appears beside your answers and, in a chat, as a photo. Text is drawn in Noto Sans whatever font-family you name, and <image> elements are never loaded. Keep it compact — every element is output you pay for. If it cannot be drawn you get the reason; fix the SVG and call again.",
    input_schema: {
      type: "object",
      properties: {
        svg: {
          type: "string",
          description:
            "A complete SVG document with a viewBox, or a width and height.",
        },
        caption: {
          type: "string",
          description: "One line saying what the picture shows.",
        },
      },
      required: ["svg", "caption"],
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
      "It runs holding less than the rest of this agent does: it can call the network and read this script's assets. It cannot read this person's stored notes — call list_memories or recall first and pass what you need into the code as a literal — and it cannot write anything, reach a stored secret, or query the database. That is enforced by the engine underneath the JavaScript, not by this description, so do not try to work around it — use remember to store something and write_response to say something.",
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
/**
 * Offered only while the run is planning.
 *
 * In `act` the plan has already been approved, and a tool whose whole effect
 * is "ask again" would spend a turn out of twelve to arrive back where it
 * started. It costs one cache miss to withdraw it: a breakpoint caches
 * everything before it, the tools sit at the front of that, so the turn after
 * an approval rewrites the prefix. Once per run, on a run that has just been
 * given permission to do the expensive half of its work.
 */
/**
 * The engine's own management tools, as two tools rather than fifty-two.
 *
 * The engine publishes around fifty native tools — scripts, assets, users,
 * secrets, logs, revisions, deployments, git. Handing the model all of their
 * schemas would be ten to fifteen thousand tokens resent on every turn of
 * every run, on a prompt whose whole cached prefix is a few hundred. So the
 * list is something to *look at* rather than something to carry: `engine_tools`
 * asks the engine what it serves, and `engine_call` calls one.
 *
 * That also keeps the list honest. What a deployment serves is a property of
 * the deployment, and a list written here would drift from it the first time
 * the engine gained a tool.
 *
 * Offered only when this execution actually holds management authority — see
 * [`hasEngineAuthority`]. A tool whose every answer is "you may not" is worse
 * than no tool: it spends a step to learn nothing and invites the model to
 * keep trying.
 */
const ENGINE_TOOLS_TOOL: ToolSpec = {
  name: "engine_tools",
  description:
    "List the engine's own management tools — for scripts, assets, users, secrets, logs, revisions and deployments. Call this before engine_call to find the right name and see what it takes. " +
    "Pass `area` to narrow the list to tools whose name or description mentions it, such as 'user', 'script', 'log' or 'revision'. Pass an empty string for all of them.",
  input_schema: {
    type: "object",
    properties: {
      area: {
        type: "string",
        description:
          "A word to narrow the list by, or an empty string for every tool.",
      },
    },
    required: ["area"],
    additionalProperties: false,
  },
  strict: true,
};

const ENGINE_CALL_TOOL: ToolSpec = {
  name: "engine_call",
  description:
    "Call one of the engine's management tools by name. Use engine_tools first to find the name and what it takes. " +
    "Every call is checked against what this person may do — you are acting as them, not as the engine — so a refusal means their account may not do it, and is not something to work around. " +
    "Reads answer straight away. Anything that changes something needs the person's approval first: ask with request_approval and say what you intend to change.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The tool's name, exactly as engine_tools gave it.",
      },
      args: {
        type: "string",
        description:
          'The tool\'s arguments as a JSON object, e.g. {"script": "..."}. Pass {} for a tool that takes none.',
      },
    },
    required: ["name", "args"],
    additionalProperties: false,
  },
  strict: true,
};

/**
 * The tools the person's own apps publish, as two tools for the reason the
 * engine's are: what is there is a property of the deployment, and the list
 * is looked at rather than carried.
 *
 * Offered only when this execution holds `call_tools` — see
 * [`hasAppAuthority`].
 */
const APP_TOOLS_TOOL: ToolSpec = {
  name: "app_tools",
  description:
    "List the tools the person's apps on this engine publish, with what each takes. Call this before app_call. " +
    "Pass `area` to narrow by a word in the tool's name, description or app, such as 'backlog'; an empty string lists all of them.",
  input_schema: {
    type: "object",
    properties: {
      area: {
        type: "string",
        description:
          "A word to narrow the list by, or an empty string for every tool.",
      },
    },
    required: ["area"],
    additionalProperties: false,
  },
  strict: true,
};

const APP_CALL_TOOL: ToolSpec = {
  name: "app_call",
  description:
    "Call one of the person's app tools by name, as them. Use app_tools first for the name and arguments. " +
    "Until a plan is approved the tool runs read-only and anything it tries to change is refused; to change something, say what with request_approval first.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The tool's name, exactly as app_tools gave it.",
      },
      args: {
        type: "string",
        description:
          "The tool's arguments as a JSON object, matching its input schema. Pass {} for a tool that takes none.",
      },
    },
    required: ["name", "args"],
    additionalProperties: false,
  },
  strict: true,
};

const REQUEST_APPROVAL_TOOL: ToolSpec = {
  name: "request_approval",
  description:
    "Ask the person to approve what you are about to do, and stop until they answer. You are currently able to read and fetch but not to change anything; approval is what lets run_js write. " +
    "Call this once you know what you intend to do, not before you have worked it out — the person is reading the plan to decide, so it has to say what you will actually change, and what you found that led you there. The run pauses here: your next turn only happens if they approve, and if they reject you will be told why and can propose something else. " +
    "Do not call it for work that only reads. Everything you can already do, you can do without asking.",
  input_schema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "What you intend to do and why, in plain language the person can agree or disagree with.",
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  strict: true,
};

/**
 * Offered in both modes, and **always** asking.
 *
 * Unlike `remember`, which writes straight through once a run is approved,
 * this defers every time and the asymmetry is deliberate. A note is one
 * person's, and wrong costs them a wrong answer. A skill is an *asset of the
 * script*, so it changes how this agent behaves for everyone who uses it, and
 * it keeps doing so until somebody notices. That is not a thing to hand a run
 * a standing licence for.
 *
 * The second reason is that it could not work otherwise. `write_files` is an
 * editor-tier capability and [`delegation`] caps background work at
 * `authenticated` on purpose — a delegated task must not be the way to get a
 * context that can author a solution. So the write cannot happen in the turn
 * at all. It happens where the approval does, in the person's own request,
 * under their own rights, which is exactly what the deferred-action plumbing
 * already does for `remember`.
 */
const WRITE_SKILL_TOOL: ToolSpec = {
  name: "write_skill",
  description:
    "Write down how to do a kind of work, so you and every future run do it the same way. Reach for this when you have just worked out a procedure worth repeating — the steps, the gotchas, the thing you got wrong the first time — not for facts about the person, which are remember's job. " +
    "Writing one always pauses the run and asks, in both modes, because a skill changes this agent for everyone who uses it and keeps doing so. Name an existing skill to replace it; read it first with read_skill so you are editing rather than overwriting. " +
    "The body is markdown and is read by you, not by the person: write it as instructions to yourself.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          'Lower-case, digits and hyphens, e.g. "weekly-report". This is the folder it lives in and how you will ask for it later.',
      },
      description: {
        type: "string",
        description:
          "One line saying when this applies. It sits in your instructions on every turn, so it has to be enough to decide by and no longer.",
      },
      body: {
        type: "string",
        description: "The instructions themselves, as markdown.",
      },
    },
    required: ["name", "description", "body"],
    additionalProperties: false,
  },
  strict: true,
};

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
  detail?: string;
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
  filter: WhereClause,
  limit: number,
  orderBy: string,
  direction: "asc" | "desc",
): unknown[] {
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rows = database.query(table, {
        where: filter,
        limit: limit,
        orderBy: orderBy,
        order: direction,
      });
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
function writeRow(run: () => unknown, what: string): boolean {
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      run();
      return true;
    } catch (e) {
      last = e;
    }
  }
  console.log(`agent: ${what} failed: ${String(last)}`);
  return false;
}

function init(): void {
  // Column names are validated against `^[a-z][a-z0-9_]*$` *and* refused when
  // they are SQL reserved words, which is why this is `speaker` rather than
  // the obvious `role`.
  database.ensureTable("messages", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "speaker", type: "text" },
      { name: "blocks", type: "text" },
      { name: "created_ms", type: "bigint" },
    ],
  });

  database.ensureTable("activities", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "kind", type: "text" },
      { name: "message", type: "text" },
      { name: "created_ms", type: "bigint" },
      // JSON the page renders beside the message: for an `attached` row,
      // which pictures it can show. Empty for every other kind.
      { name: "detail", type: "text" },
    ],
  });

  // The agent's own copy of each picture sent with a prompt, for the page to
  // show. The Files API will not hand back an uploaded file, so without this
  // a picture is a name in the log. Documents are recorded without one.
  database.ensureTable("attachments", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "file_id", type: "text" },
      { name: "name", type: "text" },
      { name: "content_type", type: "text" },
      // Base64, or empty when nothing was kept.
      { name: "preview", type: "text" },
      { name: "created_ms", type: "bigint" },
    ],
  });

  // A run's own row: what state it is in, and which queued task will take it
  // forward. Without one there was nothing to cancel — the run was only ever
  // implied by the rows that mentioned its id.
  database.ensureTable("runs", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "run_state", type: "text" },
      // What this run may do, not what it is doing: `run_state` is the
      // gate every stop goes through, this is the gate every write goes
      // through. Added after the table existed, which the read retry in
      // `queryRows` is there for.
      { name: "run_mode", type: "text" },
      // Where this run came from and where its answer goes. Empty for a
      // run started on the page, which is why nothing about the web path
      // had to change to add a channel.
      { name: "channel", type: "text" },
      { name: "chat_id", type: "text" },
      { name: "task_id", type: "text" },
      { name: "steps", type: "bigint" },
      { name: "created_ms", type: "bigint" },
      { name: "updated_ms", type: "bigint" },
      // "chat" or "author": what the run is for, which decides its tools,
      // its budgets and what it is told.
      { name: "run_kind", type: "text" },
      // JSON: for the check and for the tests, the failure an authoring run
      // last met and how many times in a row, so the third time stops it
      // instead of going round again.
      { name: "fail_sig", type: "text" },
      // Turns that spoke and did nothing, in an authoring run.
      { name: "nudges", type: "bigint" },
      // Assistant messages the conversation already held when the latest
      // prompt began, so a continued conversation starts that prompt's turn
      // budget at zero rather than at everything said before it.
      { name: "step_base", type: "bigint" },
      // The conversation's first prompt, for the list. Filled the first time
      // the list needs it, so a run's own path does not have to know.
      { name: "title", type: "text" },
      // The deployment's instructions and the person's, as they were when
      // the latest prompt began. Frozen there so an edit lands at the next
      // prompt rather than partway through a run, and so the cached prefix
      // does not move under a run that is working.
      { name: "shared_instr", type: "text" },
      { name: "own_instr", type: "text" },
    ],
  });

  // What a person tells the agent to do in every conversation. A table
  // rather than a `personalStorage` key because an approved `run_js` holds
  // `write_storage`: a page the model fetched could otherwise have it write
  // an instruction every later run obeys. Nothing the model runs holds
  // `write_script_data`, so only the person's own request writes this.
  database.ensureTable("instructions", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "body", type: "text" },
      { name: "updated_ms", type: "bigint" },
    ],
  });

  // The scripts an authoring run created, which are the only ones its tools
  // may touch.
  database.ensureTable("run_scripts", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "script", type: "text" },
      { name: "created_ms", type: "bigint" },
    ],
  });

  // What the person said while the agent was working. A table rather than a
  // column on the run, so two tabs interjecting at once cannot lose one to a
  // read-modify-write, and so the text lands in the conversation at a defined
  // point rather than wherever it happened to arrive.
  database.ensureTable("interjections", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "body", type: "text" },
      { name: "created_ms", type: "bigint" },
    ],
  });

  // A plan put to the person, and what they said about it. A table rather
  // than a column on the run for the reason `interjections` is one: two tabs
  // answering at once must not lose one to a read-modify-write, and the row
  // is worth keeping after the decision — "what was I approving" is the
  // question somebody asks a week later, and the run's state cannot answer it.
  database.ensureTable("plans", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "body", type: "text" },
      // What approving this plan actually does, when the plan was raised
      // by a tool rather than written by the model. Empty for a plan the
      // model composed itself, which approval can only re-authorise.
      { name: "action", type: "text" },
      { name: "payload", type: "text" },
      { name: "decision", type: "text" },
      // What the person said as they decided. A rejection with nothing
      // attached tells the model it was wrong and not how, which spends
      // a turn to learn one bit.
      { name: "note", type: "text" },
      { name: "created_ms", type: "bigint" },
      { name: "decided_ms", type: "bigint" },
    ],
  });

  // Column names avoid anything SQL might claim: `output` and `usage` are
  // both words a database has opinions about, and a rejected ensureTable is
  // the failure this script has already shipped once.
  database.ensureTable("turn_usage", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "cached_tokens", type: "bigint" },
      { name: "wrote_tokens", type: "bigint" },
      { name: "fresh_tokens", type: "bigint" },
      { name: "out_tokens", type: "bigint" },
      // Which version of `sent_prompts` the turn sent; empty for a
      // summarising call.
      { name: "prompt_mark", type: "text" },
      { name: "created_ms", type: "bigint" },
    ],
  });

  // What a turn sent before the conversation — the system prompt in its
  // parts, the tools and the settings — once per version per run, for the
  // inspect page. Kept rather than rebuilt when asked, because what a run
  // gets depends on what its grant held then, which a page request cannot
  // see.
  database.ensureTable("sent_prompts", {
    columns: [
      { name: "user_id", type: "text" },
      { name: "run_id", type: "text" },
      { name: "mark", type: "text" },
      { name: "system_parts", type: "text" },
      { name: "tools", type: "text" },
      { name: "settings", type: "text" },
      { name: "created_ms", type: "bigint" },
    ],
  });

  backfillRuns();

  routeRegistry.registerRoute("/agent", { file: "public/ui.html" });
  routeRegistry.registerRoute("/agent/app.js", { file: "public/app.js" });

  routeRegistry.registerRoute("/agent/prompt", {
    handler: "startRun",
    method: "POST",
    tags: ["Agent"],
    summary: "Accept a prompt and open a run",
  });
  routeRegistry.registerRoute("/agent/attachment", {
    handler: "readAttachment",
    method: "GET",
    tags: ["Agent"],
    summary: "A picture the person sent, for the page to show",
  });
  routeRegistry.registerRoute("/agent/delete", {
    handler: "deleteConversation",
    method: "POST",
    tags: ["Agent"],
    summary: "Delete a conversation, its log and its attachments",
  });
  routeRegistry.registerRoute("/agent/conversations", {
    handler: "listConversations",
    method: "GET",
    tags: ["Agent"],
    summary: "The person's earlier conversations, newest first",
  });
  routeRegistry.registerRoute("/agent/new", {
    handler: "newConversation",
    method: "POST",
    tags: ["Agent"],
    summary: "Start a new conversation; the next prompt has no earlier context",
  });
  routeRegistry.registerRoute("/agent/cancel", {
    handler: "cancelRun",
    method: "POST",
    tags: ["Agent"],
    summary: "Stop a run that is still working",
  });
  routeRegistry.registerRoute("/agent/say", {
    handler: "interject",
    method: "POST",
    tags: ["Agent"],
    summary: "Say something to a run already in progress",
  });
  routeRegistry.registerRoute("/agent/decide", {
    handler: "decideRun",
    method: "POST",
    tags: ["Agent"],
    summary: "Approve or reject the plan a run is waiting on",
  });
  routeRegistry.registerRoute("/agent/history", {
    handler: "readHistory",
    method: "GET",
    tags: ["Agent"],
    summary: "Everything this person's agent has done",
  });
  // The one route nobody signs in to reach. See `handleTelegram` for what
  // that costs and what stands in for a session.
  routeRegistry.registerRoute("/agent/telegram", {
    handler: "handleTelegram",
    method: "POST",
    tags: ["Agent"],
    summary: "Telegram webhook",
  });

  routeRegistry.registerRoute("/agent/commands", {
    handler: "listCommands",
    method: "GET",
    tags: ["Agent"],
    summary: "The /commands a prompt may begin with: /new and the skills",
  });

  routeRegistry.registerRoute("/agent/inspect", {
    file: "public/inspect.html",
  });
  routeRegistry.registerRoute("/agent/inspect.js", {
    file: "public/inspect.js",
  });

  routeRegistry.registerRoute("/agent/context", {
    handler: "readContext",
    method: "GET",
    tags: ["Agent"],
    summary: "What one conversation sends the model: prompt, tools, messages",
  });

  routeRegistry.registerRoute("/agent/instructions", {
    handler: "readInstructions",
    method: "GET",
    tags: ["Agent"],
    summary: "Your instructions for every conversation, and the deployment's",
  });
  routeRegistry.registerRoute("/agent/instructions", {
    handler: "writeInstructions",
    method: "POST",
    tags: ["Agent"],
    summary: "Save your instructions for every conversation; empty clears them",
  });

  routeRegistry.registerRoute("/agent/skills", {
    handler: "readSkills",
    method: "GET",
    tags: ["Agent"],
    summary: "Every skill with its full text, read-only",
  });

  routeRegistry.registerRoute("/agent/memories", {
    handler: "readMemories",
    method: "GET",
    tags: ["Agent"],
    summary: "Every note this agent has stored about you",
  });
  routeRegistry.registerRoute("/agent/memories", {
    handler: "writeMemory",
    method: "POST",
    tags: ["Agent"],
    summary: "Correct a note",
  });
  routeRegistry.registerRoute("/agent/memories", {
    handler: "forgetMemory",
    method: "DELETE",
    tags: ["Agent"],
    summary: "Delete a note",
  });

  routeRegistry.registerRoute("/agent/key", {
    handler: "readKeyStatus",
    method: "GET",
    tags: ["Agent"],
    summary: "Whether this person has stored an API key",
  });
  routeRegistry.registerRoute("/agent/key", {
    handler: "storeKey",
    method: "POST",
    tags: ["Agent"],
    summary: "Store this person's own API key",
  });
  routeRegistry.registerRoute("/agent/key", {
    handler: "forgetKey",
    method: "DELETE",
    tags: ["Agent"],
    summary: "Remove this person's stored API key",
  });

  // No route advances a run: `advanceRun` is reached by the queue, named by
  // the `handler` each enqueue carries.

  routeRegistry.registerRoute(STREAM_PATH, {
    stream: true,
    authorize: "tagConnection",
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

  let prompt = "";
  let kind: RunKind = "chat";
  let continuing = "";
  // A prompt carrying files arrives as a form, its fields beside the files;
  // one without arrives as JSON.
  const uploads = context.request?.files ?? [];
  let names: string[] = [];
  try {
    const body = (
      uploads.length > 0
        ? (context.request?.form ?? {})
        : (context.request?.json() ?? {})
    ) as {
      prompt?: string;
      kind?: string;
      runId?: string;
      names?: string;
    };
    prompt = String(body.prompt ?? "").trim();
    kind = runKindOf(body.kind);
    continuing = String(body.runId ?? "").trim();
    names = originalNames(body.names, uploads.length);
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }

  // `/new` is the New conversation button typed: the conversation on screen
  // is left, and the words after it, if any, begin the next one.
  const command = parseCommand(prompt);
  // `/stop` reaches here only when the page saw nothing working; a run that
  // is working is stopped through `/agent/say`.
  if (command.command === "stop") {
    return json(409, { error: "Nothing is working to stop." });
  }
  if (command.command === "new") {
    prompt = command.text;
    continuing = "";
    if (!prompt && uploads.length === 0) return startConversation(userId);
    const refusal = liveRunRefusal(userId);
    if (refusal) return refusal;
  }
  if (!prompt && uploads.length === 0) {
    return json(400, { error: "A prompt is required." });
  }
  if (!secretStorage.exists(SECRET_NAME)) {
    return json(400, {
      error: "Store your own API key before running the agent.",
      needsKey: true,
    });
  }
  if (uploads.length > MAX_ATTACHMENTS) {
    return json(400, {
      error: `Attach at most ${MAX_ATTACHMENTS} files to one prompt.`,
    });
  }
  for (let i = 0; i < uploads.length; i++) {
    if (!attachmentKind(uploads[i].contentType ?? "")) {
      return json(400, {
        error: `${names[i]} is not a picture (JPEG, PNG, GIF, WebP) or a document (PDF, plain text) the model can read.`,
      });
    }
  }
  if (continuing && !RUN_ID_PATTERN.test(continuing)) {
    return json(400, { error: "That is not a conversation id." });
  }

  // A conversation is one run id. Naming one that has messages continues it;
  // naming one that has none (the id `POST /agent/new` handed out) starts it.
  let existing: RunRow | null = null;
  let spoken = 0;
  if (continuing) {
    existing = runRow(userId, continuing);
    spoken = loadMessages(userId, continuing).filter(
      (m) => m.speaker === "assistant",
    ).length;
    if (existing && runIsLive(userId, continuing)) {
      // Spoken into with /agent/say, not restarted: a second turn queued
      // beside the live one would be two model calls for one conversation.
      return json(409, {
        error: "That conversation is still working. Say it to the run instead.",
        runLive: true,
      });
    }
    // The tools a conversation was started with are the ones its history
    // names, so what it is for does not change under it.
    if (existing) kind = runKindOf(existing.run_kind);
  }
  if (kind === "author" && !hasEngineAuthority()) {
    return json(400, {
      error:
        "Building a script needs this app to hold 'author' on your account. Grant it on your account page, then try again.",
      needsAuthority: true,
    });
  }

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

  // Uploaded before anything is stored, so a failed upload leaves no prompt
  // behind it that the model would answer without its attachments.
  let attachments: Attachment[] = [];
  if (uploads.length > 0) {
    try {
      attachments = uploadAttachments(
        uploads.map((upload, i) => ({
          name: names[i],
          contentType: String(upload.contentType ?? ""),
          data: upload.data,
        })),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return json(502, {
        error: "Could not upload the attachments: " + message,
      });
    }
  }

  const runId = continuing || newRunId();
  appendMessage(
    userId,
    runId,
    "user",
    promptBlocks(expandSkillCommand(prompt), attachments),
  );
  recordActivity(
    userId,
    runId,
    "prompt",
    prompt || "(" + attachments.length + " attached)",
  );
  if (attachments.length > 0) {
    recordAttachments(userId, runId, attachments);
  }

  // The run is the engine's from here. Queued rather than run inline so this
  // answers immediately, and `maxAttempts: 1` because a retried turn is a
  // second model call charged to this person for the same work.
  try {
    const task = personalTasks.enqueue({
      handler: "advanceRun",
      payload: { runId: runId },
      maxAttempts: 1,
    });
    if (existing) {
      reopenRun(userId, existing, task.taskId, spoken);
    } else {
      openRun(userId, runId, task.taskId, kind);
    }
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
 * Start a conversation: hand out an id and make it the one the page shows.
 *
 * Nothing is deleted. The earlier conversation's rows stay where they are; the
 * history shows the newest run id's activity, and this writes the first
 * activity of an id with no messages yet. Not pushed on the stream, so it is
 * a boundary in the table and not a line in anyone's log. Refused while a run
 * is working, because a boundary under a live run would leave it speaking into
 * a conversation the page no longer shows.
 */
function newConversation(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });
  return startConversation(userId);
}

/** `newConversation` for a person already signed in; `/new` on the page too. */
function startConversation(userId: string): HttpResponse {
  const refusal = liveRunRefusal(userId);
  if (refusal) return refusal;

  const runId = newRunId();
  try {
    database.insert("activities", {
      user_id: userId,
      run_id: runId,
      kind: "new",
      message: "",
      created_ms: Date.now(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, { error: message });
  }
  return json(200, { runId, fresh: true });
}

/** Why no new conversation may start yet: the newest one is still working. */
function liveRunRefusal(userId: string): HttpResponse | null {
  const latest = latestRunId(userId);
  if (!latest || !runIsLive(userId, latest)) return null;
  return json(409, {
    error: "Stop the run in progress first.",
    runLive: true,
  });
}

/**
 * The person's conversations, newest first: what each began with, when it was
 * last prompted, and whether it is working. Built from the prompts they wrote,
 * so a boundary with no prompt under it is not listed.
 */
function listConversations(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  // One row per conversation, most recently active first. `before` is the
  // cursor the previous page answered with: that page's oldest time.
  const before = Number(context.request?.query?.before ?? "");
  const where: Record<string, unknown> = { user_id: userId };
  if (Number.isFinite(before) && before > 0) {
    where.updated_ms = { $lt: before };
  }
  const rows = database.query("runs", {
    where: where,
    limit: CONVERSATIONS_PER_PAGE + 1,
    orderBy: "updated_ms",
    order: "desc",
  }) as unknown as RunRow[];
  const page = pageOf(Array.isArray(rows) ? rows : [], CONVERSATIONS_PER_PAGE);

  return json(200, {
    conversations: page.items.map((row) => ({
      runId: row.run_id,
      title: titleOf(userId, row),
      at: Number(row.updated_ms ?? 0),
      kind: runKindOf(row.run_kind),
      state: String(row.run_state || "done"),
    })),
    next: page.next,
  });
}

/**
 * A conversation's title, kept on its run row once known. A run's own path
 * never writes it, so the first listing after a conversation starts reads the
 * first prompt and stores what it found.
 */
function titleOf(userId: string, row: RunRow): string {
  if (row.title) return row.title;
  const prompts = database.query("activities", {
    where: { user_id: userId, run_id: row.run_id, kind: "prompt" },
    limit: 1,
    orderBy: "id",
    order: "asc",
  });
  const title = conversationTitle(prompts[0]?.message);
  if (title) {
    writeRow(
      () => database.update("runs", Number(row.id), { title: title }),
      "remembering a conversation's title",
    );
  }
  return title;
}

/**
 * Give every conversation from before the `runs` table a row of its own, so
 * the list, which reads that table, can show it. Once per database, marked in
 * script storage; a failure is logged and tried again at the next start.
 */
function backfillRuns(): void {
  const MARK = "conversations:runs-backfilled";
  try {
    if (scriptStorage.getItem(MARK)) return;

    const existing = new Set<string>();
    let after = 0;
    for (;;) {
      const page = database.query("runs", {
        where: { id: { $gt: after } },
        limit: 1000,
        orderBy: "id",
        order: "asc",
      });
      if (page.length === 0) break;
      for (const row of page) existing.add(row.user_id + "|" + row.run_id);
      after = Number(page[page.length - 1].id);
    }

    const prompts: Record<string, unknown>[] = [];
    after = 0;
    for (;;) {
      const page = database.query("activities", {
        where: { kind: "prompt", id: { $gt: after } },
        limit: 1000,
        orderBy: "id",
        order: "asc",
      });
      if (page.length === 0) break;
      prompts.push(...page);
      after = Number(page[page.length - 1].id);
    }

    const missing = legacyRuns(prompts, existing);
    database.transaction(() => {
      for (const row of missing) database.insert("runs", row);
    });
    scriptStorage.setItem(MARK, String(Date.now()));
    if (missing.length > 0) {
      console.log(
        `agent: gave ${missing.length} older conversations a run row`,
      );
    }
  } catch (e) {
    console.log("agent: could not give older conversations a run row: " + e);
  }
}

/**
 * Delete a conversation: every row it has in every table, and its files in
 * the person's Files API storage. A conversation still working is refused,
 * since its next turn would write into what was just removed.
 *
 * The files go first and on a best-effort basis: a file that cannot be
 * removed (the key was taken away, the API is down) is counted and the
 * conversation is deleted anyway, so a person can always clear their list.
 */
function deleteConversation(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let runId = "";
  try {
    const body = (context.request?.json() ?? {}) as { runId?: string };
    runId = String(body.runId ?? "").trim();
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    return json(400, { error: "That is not a conversation id." });
  }
  if (runIsLive(userId, runId)) {
    return json(409, {
      error: "That conversation is still working. Stop it first.",
      runLive: true,
    });
  }

  let filesLeft = 0;
  const files = database.query("attachments", {
    where: { user_id: userId, run_id: runId },
    limit: 1000,
  });
  for (const row of files) {
    if (!forgetFile(String(row.file_id ?? ""))) filesLeft += 1;
  }

  try {
    database.transaction(() => {
      for (const table of CONVERSATION_TABLES) {
        database.deleteWhere(table, { user_id: userId, run_id: runId });
      }
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, {
      error: "Could not delete the conversation: " + message,
    });
  }
  return json(200, { deleted: true, filesLeft: filesLeft });
}

function latestRunId(userId: string): string {
  const rows = database.query("activities", {
    where: { user_id: userId },
    limit: 1,
    orderBy: "id",
    order: "desc",
  }) as unknown as ActivityRow[];
  return Array.isArray(rows) && rows.length > 0
    ? String(rows[0].run_id ?? "")
    : "";
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
  if (overHistoryLimit(history.length)) {
    recordActivity(
      userId,
      runId,
      "error",
      `Stopped: this run passed ${MAX_HISTORY_ROWS} messages without finishing.`,
    );
    finishRun(userId, runId, "history-limit");
    return;
  }

  const kind = kindOf(userId, runId);
  const stepLimit = maxStepsFor(kind);
  const taken = stepsTaken(userId, runId, history);
  if (taken >= stepLimit) {
    recordActivity(
      userId,
      runId,
      "error",
      `Stopped after ${stepLimit} turns without finishing.`,
    );
    // A run that was building a script leaves the person something to act on
    // rather than only a reason.
    if (kind === "author") {
      escalate(
        userId,
        runId,
        "",
        `I used all ${stepLimit} turns without finishing.`,
        "(no verdict: the run ran out of turns)",
      );
    }
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
    if (
      e instanceof ModelApiError &&
      e.status === 400 &&
      setAsideRefused(userId, runId, history, e.detail)
    ) {
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    recordActivity(userId, runId, "error", message);
    finishRun(userId, runId, "error");
    return;
  }

  // A refusal is an HTTP 200 with no usable content, so this has to be read
  // before `content` is touched. The model's safety classifiers can decline a
  // request, and there is no fallback model: sending it again usually draws
  // the same answer, so the run ends here.
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
  // An authoring turn that spoke and called nothing has done nothing, and
  // ending the run there is how a small model ends it having only announced
  // the work. It is told to act instead, a few times, before it is believed.
  const spoke = blocks.some((block) => block.type === "text" && block.text);
  const calledATool = blocks.some(
    (block) => block.type === "tool_use" && block.id && block.name,
  );
  const nudgesSoFar = Number(runRow(userId, runId)?.nudges ?? 0);
  const nudging =
    kind === "author" && !calledATool && spoke && nudgesSoFar < MAX_NUDGES;
  const proseKind = nudging ? "note" : proseKindFor(blocks);

  let said = false;
  const results: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      recordActivity(userId, runId, proseKind, block.text);
      // Narration stays on the page; an answer follows the run. A turn that
      // called no tool has answered in prose, and a person on Telegram is
      // owed that as much as one watching the stream.
      if (proseKind === "response") {
        notifyChannel(userId, runId, block.text);
      }
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

  if (nudging) {
    const row = runRow(userId, runId);
    if (row) {
      writeRow(
        () =>
          database.update("runs", Number(row.id), {
            nudges: nudgesSoFar + 1,
            updated_ms: Date.now(),
          }),
        "counting a nudge",
      );
    }
    appendMessage(userId, runId, "user", [{ type: "text", text: NUDGE }]);
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

  // A turn that neither spoke nor did anything would end the run in silence,
  // which reads as the agent having crashed.
  //
  // Two ways to arrive here and only one of them is wrong. A turn cut off at
  // `max_tokens` before any block completed is a real failure and says so.
  // A turn that had genuinely nothing left to add, in a run that has already
  // answered, is just the end — and calling that an error put a red line on
  // the end of a run that did everything asked of it.
  if (!said && results.length === 0) {
    if (answer.stop_reason === "max_tokens") {
      recordActivity(
        userId,
        runId,
        "error",
        "The reply was cut off before anything was said. The token ceiling may be too low.",
      );
    } else if (!alreadyAnswered(userId, runId)) {
      recordActivity(
        userId,
        runId,
        "error",
        "The model ended the turn without saying anything.",
      );
    }
    // Else: it had said its piece and had nothing to add. The `done` activity
    // that follows is the whole of what needs recording.
  }

  if (results.length > 0) {
    // Every result in one user message: splitting them teaches the model to
    // stop calling tools in parallel.
    appendMessage(userId, runId, "user", results);

    // A turn whose only tool call was `write_response` has said its piece,
    // and there is nothing for a successor to read: the tool answers
    // "Delivered." and carries no information back. Queueing one anyway is
    // what put a dead turn on the end of *every* run — a whole prompt resent
    // to buy two tokens of nothing, on somebody's own key, and then an error
    // line for having answered the way the system prompt asks.
    //
    // So answering is terminal, and a turn that means to answer *and* carry
    // on says so by calling the tool it needs in the same turn. That is the
    // contract the system prompt states, rather than a guess made here: the
    // model cannot tell us it has more to do after the fact, so the only
    // honest signal is one it gives while it still has the turn.
    const workedOn = blocks.some(
      (block) =>
        block.type === "tool_use" &&
        block.name &&
        block.name !== "write_response",
    );
    if (!workedOn) {
      // "end_turn" rather than the raw `stop_reason`, which here is always
      // "tool_use" — true of the API and meaningless to the person reading
      // "DONE tool_use" at the bottom of a run that simply answered.
      finishRun(userId, runId, "end_turn");
      return;
    }

    // The next turn, queued rather than run here — same reasoning as the
    // first: one model call per execution budget.
    // Re-read rather than trusting the check at the top: a cancel can land
    // during the model call, which is the one part of a turn that cannot be
    // interrupted. Catching it here stops the run a whole turn earlier than
    // the next gate would.
    // Not only a cancel: a turn that called `request_approval` set this to
    // `waiting`, and declining to queue a successor is exactly how a run
    // suspends. The gate is the same one either way, which is the point.
    const now = runStateOf(userId, runId);
    if (now !== null && now !== "running") {
      console.log(`agent: run ${runId} is ${now}; not queuing another turn`);
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
 * Tell the person's open tabs that the run is over.
 *
 * The page waits on no response, so the end of a run arrives the way
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
    notifyChannel(
      userId,
      runId,
      `I finished before I read this, so it was not answered: "${said}"`,
    );
  }

  // Only from `running`: a turn that finishes normally must not overwrite a
  // cancel that landed while it was working, or the page would be told the
  // run ended by itself and the row would say the same.
  setRunState(userId, runId, "done", undefined, "running");
  recordActivity(userId, runId, "done", reason);

  // A run that ended badly is worth saying out loud on a channel, where there
  // is no activity log to notice it in. A run that simply finished has
  // already said whatever it had to say.
  if (reason !== "end_turn") {
    notifyChannel(userId, runId, `The run stopped: ${reason}.`);
  }
  notifySpend(userId, runId);
}

/**
 * Under the answer on a channel, what it cost: the page shows a spend line
 * and a chat has nowhere else to, while the key it spends is the person's own.
 * This prompt's turns only, not the conversation's, since that is what the
 * person just asked for.
 */
function notifySpend(userId: string, runId: string): void {
  const to = channelFor(userId, runId);
  if (!to) return;
  const line = spendLine(promptSpend(userId, runId), PRICES);
  if (line) sendTelegram(to.chatId, "Spent: " + line, undefined, true);
}

/** What the turns since the conversation's latest prompt have spent. */
function promptSpend(userId: string, runId: string) {
  try {
    const prompts = queryRows(
      "activities",
      { user_id: userId, run_id: runId, kind: "prompt" },
      1,
      "id",
      "desc",
    ) as { created_ms?: unknown }[];
    const since = Number(prompts[0]?.created_ms ?? 0) || 0;
    return spendOf(
      queryRows(
        "turn_usage",
        { user_id: userId, run_id: runId, created_ms: { $gte: since } },
        MOST_STEPS + 1,
        "id",
        "asc",
      ),
    );
  } catch (e) {
    // A missing footnote is better than a failed end to the run.
    return emptySpend();
  }
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

  const stopped = stopRun(userId, row);
  if (!stopped.stopped) {
    // Already over. Not an error: the person pressed stop as it finished.
    return json(200, {
      runId: runId,
      state: stopped.state,
      alreadyEnded: true,
    });
  }
  return json(200, { runId: runId, state: "cancelled" });
}

/**
 * Stop a run that is working: the page's Stop, and `/stop` on the page and in
 * Telegram. A run already over is left as it is, and its state reported.
 */
function stopRun(
  userId: string,
  row: RunRow,
): { stopped: boolean; state: string } {
  const runId = String(row.run_id);
  const state = String(row.run_state ?? "running");
  if (state !== "running" && state !== "waiting") {
    return { stopped: false, state: state };
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
  return { stopped: true, state: "cancelled" };
}

/**
 * The page's way of answering a plan: parse, hand to [`decide`], report.
 *
 * Everything that moves the run lives there rather than here, because a
 * decision now arrives two ways — this, and a button under a Telegram
 * message — and the second has no request to answer.
 */
function decideRun(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let runId = "";
  let decision = "";
  let note = "";
  try {
    const body = (context.request?.json() ?? {}) as {
      runId?: string;
      decision?: string;
      note?: string;
    };
    runId = String(body.runId ?? "").trim();
    decision = String(body.decision ?? "").trim();
    note = String(body.note ?? "").trim();
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!runId) return json(400, { error: "A runId is required." });
  if (decision !== "approve" && decision !== "reject") {
    return json(400, { error: 'Decision must be "approve" or "reject".' });
  }

  const outcome = decide(userId, runId, decision, note);
  return json(outcome.status, outcome.body);
}

/**
 * Answer the plan a run is waiting on, and let it go again.
 *
 * The resuming half, and the ordering is the whole of it. The transition out
 * of `waiting` is taken **first and conditionally**, before any message is
 * written or any task is queued, because that single write is the mutex: two
 * tabs pressing approve, a tab and a Telegram button, or one person
 * double-tapping, all reach here and exactly one moves the run. The loser
 * changes nothing and is answered as though it had won, since from the
 * person's side it did.
 *
 * Doing it the other way round — queue, then set the state — is what
 * `advanceRun` does, and it is wrong here for a reason that does not apply
 * there: a second caller would have queued a second turn before discovering
 * it lost, and the run would take two turns for one approval, each paid for
 * on somebody's own key.
 *
 * Then the message, then the task. The message has to be in the conversation
 * before anything can read it, and the queued turn is exactly a thing that
 * reads it.
 *
 * A rejection resumes the run rather than ending it. The model is told what
 * was wrong and gets to propose something else, which is the difference
 * between a decision and a stop — and the step ceiling bounds how many times that
 * can go round.
 *
 * Separate from the HTTP handler because a decision arrives two ways now: a
 * button on the page, and a button under a Telegram message. One of them has
 * no request to answer and no JSON to parse, and both must move the run
 * identically — building that twice is how they come to disagree.
 */
function decide(
  userId: string,
  runId: string,
  decision: string,
  note: string,
): { ok: boolean; status: number; detail: string; body: unknown } {
  // Scoped to this person in the query, so another account's run id finds
  // nothing rather than being decided.
  const row = runRow(userId, runId);
  if (!row) {
    return {
      ok: false,
      status: 404,
      detail: "That run is not one of yours.",
      body: { error: "No such run." },
    };
  }

  const plan = pendingPlan(userId, runId);

  // The mutex. Everything below this line happens once.
  if (!setRunState(userId, runId, "running", undefined, "waiting")) {
    const state = String(row.run_state ?? "running");
    return {
      ok: true,
      status: 200,
      detail: "That was already answered.",
      body: { runId: runId, state: state, alreadyDecided: true },
    };
  }

  const approved = decision === "approve";
  if (plan) {
    writeRow(
      () =>
        database.update("plans", Number(plan.id), {
          decision: approved ? "approved" : "rejected",
          note: note,
          decided_ms: Date.now(),
        }),
      "recording a decision",
    );
  }

  // An authoring run's one approval is for one deploy and is carried out
  // below; it does not widen the run, so its next deploy asks again.
  if (approved && kindOf(userId, runId) !== "author") {
    // What the mode is for. Written before the turn is queued, so the turn
    // that reads it cannot see the old one.
    writeRow(
      () =>
        database.update("runs", Number(row.id), {
          run_mode: "act",
          updated_ms: Date.now(),
        }),
      "widening a run",
    );
  }

  recordActivity(
    userId,
    runId,
    "decision",
    approved
      ? "You approved the plan." + (note ? " " + note : "")
      : "You rejected the plan." + (note ? " " + note : ""),
  );

  // Carried out here rather than left to the resumed model, which does not
  // reliably do it. After the decision is recorded, so the activity log reads
  // in the order the person lived it — approved, then done, rather than done
  // then approved — and before the turn is queued, so the model is told about
  // work that has happened rather than work that is about to.
  //
  // This is the person's own request, which is the one context where
  // `personalStorage` resolves to them.
  const carriedOut =
    approved && plan ? performApproved(userId, runId, plan) : null;
  // A secret's value waited in the plan only to be carried out. Whatever the
  // answer, it is not kept: a rejected one was never going to be used.
  if (plan && String(plan.action ?? "") === "write_secret") {
    writeRow(
      () => database.update("plans", Number(plan.id), { payload: "" }),
      "clearing a secret from a plan",
    );
  }

  // Delivered as an ordinary message rather than an interjection: the run is
  // suspended, so there is no turn in flight to race, and this has to be the
  // last thing the next turn reads.
  const told = approved
    ? "[The person approved your plan." +
      (note ? ' They added: "' + note + '"' : "") +
      (carriedOut
        ? " It has been carried out for you — " +
          carriedOut +
          ". Do not repeat the call; tell them briefly and stop.]"
        : " run_js can now write. Carry it out.]")
    : "[The person rejected your plan." +
      (note ? ' They said: "' + note + '"' : "") +
      " Do not carry it out. Propose something else, or tell them why you cannot.]";
  appendMessage(userId, runId, "user", [{ type: "text", text: told }]);

  try {
    const task = personalTasks.enqueue({
      handler: "advanceRun",
      payload: { runId: runId },
      maxAttempts: 1,
    });
    setRunState(userId, runId, "running", task.taskId, "running");
  } catch (e) {
    // Most likely the grant lapsed while the plan sat waiting, which is the
    // longest any run is idle and so the likeliest moment for it.
    const message = e instanceof Error ? e.message : String(e);
    recordActivity(userId, runId, "error", `The run stopped: ${message}`);
    finishRun(userId, runId, "error");
    return {
      ok: false,
      status: 500,
      detail: `The run stopped: ${message}`,
      body: { error: message },
    };
  }

  return {
    ok: true,
    status: 200,
    detail: approved ? "Approved." : "Rejected.",
    body: { runId: runId, state: "running", mode: approved ? "act" : "plan" },
  };
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
/**
 * Upload a prompt's files to the person's Anthropic Files API, with their own
 * key, and answer what the conversation should refer to.
 *
 * All or nothing: when one upload fails the ones before it are removed again,
 * because they would sit in the person's storage referred to by nothing.
 */
function uploadAttachments(
  files: { name: string; contentType: string; data: string }[],
): Attachment[] {
  // Checked before any is uploaded: the Files API takes a picture the
  // Messages API then refuses, and the refusal would come a turn later.
  for (const file of files) {
    const reason = tooLargeToRead(
      file.name,
      file.contentType,
      file.data.length,
    );
    if (reason) throw new Error(reason + ". Send a smaller one.");
  }
  const done: Attachment[] = [];
  for (let i = 0; i < files.length; i++) {
    const name = files[i].name;
    const contentType = files[i].contentType.split(";")[0].trim().toLowerCase();
    const response = fetch(FILES_URL, {
      method: "POST",
      timeout: MODEL_TIMEOUT_MS,
      headers: {
        "x-api-key": "{{secret:" + SECRET_NAME + "}}",
        "anthropic-version": "2023-06-01",
      },
      form: [
        {
          name: "file",
          base64: files[i].data,
          filename: name,
          contentType: contentType,
        },
      ],
    });
    let answer: { id?: string; error?: { message?: string } } = {};
    try {
      answer = response.json() as typeof answer;
    } catch (e) {
      answer = {};
    }
    if (!response.ok || !answer.id) {
      forgetFiles(done);
      throw new Error(
        name +
          ": " +
          (answer.error?.message ??
            `the Files API answered ${response.status}`),
      );
    }
    done.push({
      name: name,
      contentType: contentType,
      fileId: answer.id,
      data: files[i].data,
    });
  }
  return done;
}

/**
 * Write the log row naming what was attached, keeping a copy of each picture
 * the page can show. A copy that cannot be stored costs only the picture on
 * the page, so it is logged and the prompt goes on.
 */
function recordAttachments(
  userId: string,
  runId: string,
  attachments: Attachment[],
): void {
  const detail: AttachmentDetail[] = attachments.map((attachment) => {
    const preview = previewOf(attachment.contentType, attachment.data ?? "");
    let id = 0;
    try {
      id = database.insert("attachments", {
        user_id: userId,
        run_id: runId,
        file_id: attachment.fileId,
        name: attachment.name,
        content_type: attachment.contentType,
        preview: preview,
        created_ms: Date.now(),
      }).id;
    } catch (e) {
      quietLog(`agent: could not keep a copy of ${attachment.name}: ${e}`);
    }
    return {
      id: id,
      name: attachment.name,
      kind: attachmentKind(attachment.contentType) ?? "document",
      preview: preview !== "" && id > 0,
    };
  });
  recordActivity(
    userId,
    runId,
    "attached",
    describeAttachments(attachments),
    detail,
  );
}

/**
 * Show a picture the agent drew: kept as an attachment row with no uploaded
 * file behind it, so the page fetches it the way it fetches one the person
 * sent, and sent on to the chat the run came from.
 */
function showPicture(
  userId: string,
  runId: string,
  png: string,
  caption: string,
): void {
  const name = "picture.png";
  let id = 0;
  try {
    id = database.insert("attachments", {
      user_id: userId,
      run_id: runId,
      file_id: "",
      name: name,
      content_type: "image/png",
      preview: png,
      created_ms: Date.now(),
    }).id;
  } catch (e) {
    quietLog(`agent: could not keep a picture: ${e}`);
  }
  recordActivity(userId, runId, "picture", caption, [
    { id: id, name: caption || name, kind: "image", preview: id > 0 },
  ]);
  const to = channelFor(userId, runId);
  if (to) sendTelegramPhoto(to.chatId, png, caption);
}

/**
 * Serve the agent's copy of a picture — one the person sent, or one the agent
 * drew — to that person and nobody else. Only pictures are kept, so what this
 * answers is always an image.
 */
function readAttachment(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });
  const id = Number(context.request?.query?.id ?? "");
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { error: "That is not an attachment id." });
  }
  const rows = database.query("attachments", {
    where: { id: id, user_id: userId },
    limit: 1,
  });
  const row = rows[0];
  const contentType = String(row?.content_type ?? "");
  if (!row || !row.preview || attachmentKind(contentType) !== "image") {
    return json(404, { error: "No such picture." });
  }
  return {
    status: 200,
    bodyBase64: String(row.preview),
    contentType: contentType,
    headers: {
      // A row never changes once written.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  };
}

/** Remove uploaded files, as far as that works. Nothing refers to them. */
function forgetFiles(attachments: Attachment[]): void {
  for (const attachment of attachments) forgetFile(attachment.fileId);
}

/**
 * Remove one file from the person's Files API storage. Answers whether it is
 * gone, which a file that was already removed is.
 */
function forgetFile(fileId: string): boolean {
  if (!fileId) return true;
  try {
    const answer = fetch(FILES_URL + "/" + encodeURIComponent(fileId), {
      method: "DELETE",
      headers: {
        "x-api-key": "{{secret:" + SECRET_NAME + "}}",
        "anthropic-version": "2023-06-01",
      },
    });
    return answer.ok || answer.status === 404;
  } catch (e) {
    console.log("agent: could not remove an uploaded file: " + String(e));
    return false;
  }
}

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
  // Not words for the model: `/stop` is the Stop button typed, and a new
  // conversation under a live run is refused, as the button is.
  const command = parseCommand(text).command;
  if (command === "stop") {
    const row = runRow(userId, runId);
    if (row) stopRun(userId, row);
    return json(200, { runId: runId, stopped: true });
  }
  if (command === "new") {
    return json(409, {
      error: "Stop the run in progress first.",
      runLive: true,
    });
  }

  try {
    database.insert("interjections", {
      user_id: userId,
      run_id: runId,
      body: expandSkillCommand(text),
      created_ms: Date.now(),
    });
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

  // One conversation: the one asked for, else the newest. A run id is a
  // conversation, and the page shows the one it would continue.
  const asked = String(context.request?.query?.runId ?? "").trim();
  if (asked && !RUN_ID_PATTERN.test(asked)) {
    return json(400, { error: "That is not a conversation id." });
  }
  const latestRun = asked || latestRunId(userId);
  const rows = latestRun
    ? (database.query("activities", {
        where: { user_id: userId, run_id: latestRun },
        limit: MAX_HISTORY_ROWS,
        orderBy: "id",
        order: "desc",
      }) as unknown as ActivityRow[])
    : [];

  const ordered = Array.isArray(rows)
    ? rows.filter((row) => row.kind !== "new").reverse()
    : [];

  const waitingOn = latestRun ? pendingPlan(userId, latestRun) : null;

  return json(200, {
    activities: ordered.map((row) => ({
      runId: row.run_id,
      kind: row.kind,
      message: row.message,
      detail: parseDetail(row.detail),
      at: Number(row.created_ms),
    })),
    hasKey: secretStorage.exists(SECRET_NAME),
    authorization: personalTasks.authorization(),
    runId: latestRun,
    // Whether the conversation has anything to continue, and what it is for.
    hasConversation: latestRun
      ? loadMessages(userId, latestRun).length > 0
      : false,
    runKind: latestRun ? kindOf(userId, latestRun) : "chat",
    // So a page opened while a run is working shows a stop button, rather
    // than learning the run exists only if a turn happens to land.
    runState: latestRun ? (runStateOf(userId, latestRun) ?? "done") : "done",
    // So a page opened while a run is suspended shows the plan and its two
    // buttons, rather than a run that looks stuck for no stated reason.
    pendingPlan: waitingOn
      ? { body: String(waitingOn.body ?? ""), at: Number(waitingOn.created_ms) }
      : null,
    spend: runSpend(userId, latestRun),
    // Sent rather than duplicated in the page, so the rates the numbers were
    // costed with cannot drift away from the model that produced them.
    pricing: PRICES,
    contextWindow: CONTEXT_WINDOW,
  });
}

/** How many turns and prompt versions the inspect page reads for one run. */
const MAX_INSPECT_TURNS = 200;
const MAX_INSPECT_PROMPTS = 20;

/**
 * The person's own instructions and the deployment's, for the inspect page.
 */
function readInstructions(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });
  return json(200, {
    own: ownInstructions(userId),
    shared: tidyInstructions(
      readAssetText(SHARED_INSTRUCTIONS_FILE) ?? "",
      MAX_SHARED_INSTRUCTIONS_CHARS,
    ),
    sharedFile: SHARED_INSTRUCTIONS_FILE,
    max: MAX_OWN_INSTRUCTIONS_CHARS,
  });
}

/**
 * Saves what the person tells the agent to do in every conversation; empty
 * clears it. Taken up by the next prompt, not by a run that is working. No
 * plan/act gate, for the reason the notes have none: this is the person, in
 * their own request, editing their own text.
 */
function writeInstructions(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let text = "";
  try {
    const body = (context.request?.json() ?? {}) as { text?: string };
    text = String(body.text ?? "")
      .replace(/\r\n?/g, "\n")
      .trim();
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  const problem = ownInstructionsProblem(text);
  if (problem) return json(400, { error: problem });

  try {
    database.transaction(() => {
      database.deleteWhere("instructions", { user_id: userId });
      if (text) {
        database.insert("instructions", {
          user_id: userId,
          body: text,
          updated_ms: Date.now(),
        });
      }
    });
  } catch (e) {
    return json(500, { error: "Could not save your instructions: " + e });
  }
  return json(200, { own: text });
}

/**
 * Everything one conversation sends the model, for the inspect page: each
 * version of the system prompt, tools and settings its turns sent, which
 * version each turn used and what it cost, and the conversation itself as the
 * next turn would send it.
 *
 * The person's own rows only. Nothing here is secret from them: the key is
 * not in the request — the engine fills it in on the way out — and the rest
 * is their conversation and instructions the model would repeat if asked.
 */
function readContext(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  const asked = String(context.request?.query?.runId ?? "").trim();
  if (asked && !RUN_ID_PATTERN.test(asked)) {
    return json(400, { error: "That is not a conversation id." });
  }
  const runId = asked || latestRunId(userId);
  if (!runId) {
    return json(200, {
      runId: "",
      prompts: [],
      turns: [],
      messages: [],
      pricing: PRICES,
    });
  }

  let prompts: SentPrompt[] = [];
  let turns: Record<string, unknown>[] = [];
  let messages: ApiMessage[] = [];
  try {
    for (const row of queryRows(
      "sent_prompts",
      { user_id: userId, run_id: runId },
      MAX_INSPECT_PROMPTS,
      "id",
      "asc",
    )) {
      const kept = sentPromptOf(row as Record<string, unknown>);
      if (kept) prompts.push(kept);
    }
    turns = (
      queryRows(
        "turn_usage",
        { user_id: userId, run_id: runId },
        MAX_INSPECT_TURNS,
        "id",
        "asc",
      ) as Record<string, unknown>[]
    ).map((row) => ({
      at: Number(row.created_ms ?? 0),
      mark: String(row.prompt_mark ?? ""),
      cached: Number(row.cached_tokens ?? 0),
      wrote: Number(row.wrote_tokens ?? 0),
      fresh: Number(row.fresh_tokens ?? 0),
      output: Number(row.out_tokens ?? 0),
    }));
    messages = loadMessages(userId, runId).map(toApiMessage);
  } catch (e) {
    return json(500, { error: "Could not read the conversation: " + e });
  }

  const row = runRow(userId, runId);
  return json(200, {
    runId: runId,
    title: row ? titleOf(userId, row) : "",
    kind: kindOf(userId, runId),
    mode: runModeOf(userId, runId),
    prompts: prompts,
    turns: turns,
    messages: messages,
    pricing: PRICES,
  });
}

/**
 * Every skill with its full text, for the inspect page. Read-only: a skill
 * changes the agent for everyone, so changing one stays with `write_skill`
 * and its approval, or with whoever can edit this script.
 */
function readSkills(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  const assets = listAssetInfo();
  const skills = loadSkills().map((skill) => {
    const folder = SKILLS_PREFIX + skill.name + "/";
    const text = readAssetText(folder + SKILL_FILE);
    const body = text === null ? "" : skillBody(text);
    const others: string[] = [];
    for (const asset of assets) {
      if (asset.path.indexOf(folder) !== 0) continue;
      const file = asset.path.slice(folder.length);
      if (file !== SKILL_FILE) others.push(file);
    }
    return {
      name: skill.name,
      description: skill.description,
      body: body.slice(0, MAX_SKILL_CHARS),
      cut: body.length > MAX_SKILL_CHARS,
      files: others,
    };
  });
  return json(200, { skills: skills });
}

/**
 * Everything this agent has written down about the person asking.
 *
 * The half of memory that was missing. `list_memories` made the notes
 * readable by the *model*, which is a different thing and was never the point
 * — an agent that remembers things about somebody without showing them what
 * it remembers is one they cannot correct.
 *
 * It stopped being only a principle this week. Twice in one afternoon this
 * agent told its owner it had saved a preference and had not, and both times
 * the only way to find out was to read the database. A person with this panel
 * open would have seen it in a second.
 *
 * No plan/act gate anywhere in these three handlers, and the reason is worth
 * being explicit about: the mode governs what the *agent* may do while acting
 * for somebody. This is the somebody, in their own request, editing their own
 * store. Asking them to approve their own correction would be theatre.
 */
/** What the prompt box completes after a `/`. */
function listCommands(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });
  return json(200, { commands: menuCommands(loadSkills()) });
}

function readMemories(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  const keys: string[] = [];
  try {
    const total = personalStorage.length;
    for (let i = 0; i < total; i++) {
      const stored = personalStorage.key(i);
      if (stored === null) continue;
      if (stored.indexOf(NOTE_PREFIX) !== 0) continue;
      keys.push(stored);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, { error: message });
  }

  keys.sort();
  const shown = keys.slice(0, MAX_MEMORIES);
  const memories: MemoryView[] = [];
  for (const stored of shown) {
    const value = personalStorage.getItem(stored);
    if (value === null) continue;
    const long = value.length > MAX_MEMORY_VALUE_CHARS;
    memories.push({
      key: stored.slice(NOTE_PREFIX.length),
      value: long ? value.slice(0, MAX_MEMORY_VALUE_CHARS) : value,
      chars: value.length,
      truncated: long,
    });
  }

  return json(200, {
    memories: memories,
    more: keys.length - shown.length,
    maxChars: MAX_MEMORY_VALUE_CHARS,
  });
}

/**
 * Correct a note, or write one.
 *
 * An upsert rather than an update, because refusing an unknown key would buy
 * nothing: the store is the person's, and a key they typed is as much theirs
 * as one the model chose. The page only offers to edit notes that exist,
 * which is a statement about what the panel is for — correcting what the
 * agent believes — rather than a limit this endpoint needs to enforce.
 *
 * A run already in flight will not see the change until it next calls recall:
 * the turn reading the conversation has already read it. That is the same
 * rule interjections follow and needs no special handling here, because a
 * note is read when it is asked for rather than carried in the prompt.
 */
function writeMemory(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  let key = "";
  let value = "";
  try {
    const body = (context.request?.json() ?? {}) as {
      key?: string;
      value?: string;
    };
    key = String(body.key ?? "").trim();
    value = String(body.value ?? "");
  } catch (e) {
    return json(400, { error: "Expected a JSON body." });
  }
  if (!key) return json(400, { error: "A key is required." });
  if (value.length > MAX_MEMORY_VALUE_CHARS) {
    return json(400, {
      error: `A note is at most ${MAX_MEMORY_VALUE_CHARS} characters.`,
    });
  }

  try {
    personalStorage.setItem(NOTE_PREFIX + key, value);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, { error: message });
  }
  return json(200, { key: key, chars: value.length });
}

/**
 * Delete a note.
 *
 * The thing no tool offered and no page offered either, so a note the agent
 * got wrong could be corrected but never taken back. Removing a key that is
 * not there is not an error — it is the state the caller asked for.
 *
 * The key arrives in the query string rather than a body, because a body on a
 * DELETE is the kind of thing that works until something between here and the
 * browser decides otherwise. `/agent/key` already deletes with no body at all;
 * this one needs to name which note, and a query parameter is the form that
 * every layer agrees about.
 */
function forgetMemory(context: HandlerContext): HttpResponse {
  const userId = signedInUser(context);
  if (!userId) return json(401, { error: "Sign in first." });

  const key = String(context.request?.query?.key ?? "").trim();
  if (!key) return json(400, { error: "A key is required." });

  try {
    personalStorage.removeItem(NOTE_PREFIX + key);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, { error: message });
  }
  return json(200, { key: key });
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

  try {
    secretStorage.setSecret(SECRET_NAME, key);
  } catch (e) {
    return json(400, { error: e instanceof Error ? e.message : String(e) });
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
 * `Authorization: Bearer {{secret:...}}` works too.
 *
 * `fetchStream` rather than `fetch`, which returns only once the whole body
 * has arrived — the agent's longest silence would be the part where it was
 * working hardest. `fetchStream` hands back the status and headers immediately and the body in
 * pieces, which is what lets an answer appear while it is still being written.
 *
 * What comes back from here is a whole `ApiResponse`. The streaming is
 * contained in this section on purpose: `advanceRun` stores
 * blocks and dispatches tools exactly as it did, and cannot tell that the
 * answer was assembled rather than parsed.
 */
/** The model API refusing a request, with its status and what it said. */
class ModelApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`The model API answered ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Take out the attachments a refused request was about, and queue the turn
 * again without them.
 *
 * The conversation is resent whole on every turn, so a picture or document
 * the API will not read would otherwise fail this turn and every one after
 * it. Each is replaced by a line saying what was there and why it is gone,
 * the person is told, and the turn is tried once more. False when the
 * refusal is not about an attachment, or the rows cannot be rewritten; the
 * caller then ends the run as before. Every retry removes at least one
 * attachment and counts as a turn, so this cannot go round for ever.
 */
function setAsideRefused(
  userId: string,
  runId: string,
  history: MessageRow[],
  detail: string,
): boolean {
  const sent = history.map(toApiMessage);
  const refused = refusedAttachments(detail, sent);
  if (refused.length === 0) return false;

  const names: Record<string, string> = {};
  try {
    const rows = database.query("attachments", {
      where: { user_id: userId, run_id: runId },
      limit: 1000,
    });
    for (const row of rows) {
      names[String(row.file_id ?? "")] = String(row.name ?? "");
    }
  } catch (e) {
    // Only the names in the note are lost.
  }

  const gone: string[] = [];
  const byMessage: Record<number, number[]> = {};
  for (const at of refused) {
    (byMessage[at.message] = byMessage[at.message] ?? []).push(at.block);
    gone.push(refusedName(sent[at.message].content[at.block], names));
  }
  for (const key of Object.keys(byMessage)) {
    const m = Number(key);
    const ok = writeRow(
      () =>
        database.update("messages", Number(history[m].id), {
          blocks: JSON.stringify(
            withoutRefused(sent[m].content, byMessage[m], names, detail),
          ),
        }),
      "setting aside an attachment the model could not read",
    );
    if (!ok) return false;
  }

  const note = `I could not read ${gone.join(", ")}, so I carried on without it. The model API said: ${detail}`;
  recordActivity(userId, runId, "error", note);
  notifyChannel(userId, runId, note);
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
  return true;
}

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
  // Both of the lines below follow the run's mode, which changes at most once
  // in a run — when a plan is approved. That rewrites the cached prefix, since
  // the tools sit at the front of it; see `REQUEST_APPROVAL_TOOL`.
  const mode = summarising ? "plan" : runModeOf(userId, runId);
  const kind: RunKind = kindOf(userId, runId);
  // Everything before the conversation, built once so what is sent and what
  // is kept for the inspect page are the same values.
  const parts = summarising
    ? []
    : systemPartsFor(skills, mode, kind, frozenInstructions(userId, runId));
  const toolList = summarising ? undefined : toolsFor(skills, mode, kind);
  const settings = {
    model: MODEL,
    max_tokens: maxTokensFor(kind),
    cache_control: summarising ? undefined : { type: "ephemeral" },
    thinking: {
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
    output_config: { effort: EFFORT },
    anthropic_beta: BETA_HEADER,
  };
  const mark = summarising
    ? ""
    : keepSentPrompt(userId, runId, parts, toolList ?? [], settings);
  const stream = fetchStream(API_URL, {
    method: "POST",
    // Without this the call inherits the engine's 30-second default. See
    // `MODEL_TIMEOUT_MS` — it is the reason long turns failed as timeouts.
    timeout: MODEL_TIMEOUT_MS,
    headers: {
      "x-api-key": "{{secret:" + SECRET_NAME + "}}",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA_HEADER,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: settings.max_tokens,
      // Both of these follow the skill library rather than the turn, so they
      // are as stable across a run as anything else in the cached prefix.
      system: summarising ? COMPACT_PROMPT : joinParts(parts),
      messages: messages,
      tools: toolList,
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
      // It does nothing at all until the whole prompt passes 512 tokens,
      // and that number is the model's rather than a choice: a shorter prefix
      // is refused silently — no error, just a `usage` that reports nothing
      // cached. The tools and system prompt come to roughly 400 tokens
      // together, so they are not enough on their own; a conversation is,
      // within a turn or two, and that is the run whose bill is worth
      // cutting. The 5-minute TTL is deliberate: a turn is queued the moment
      // the one before it ends, so every turn refreshes the entry, and the
      // 1-hour TTL would double the write price to buy a gap this loop does
      // not have.
      cache_control: settings.cache_control,
      // Thinking counts toward `max_tokens`, so a ceiling sized for a model
      // that did not think can end a turn before it says anything; see
      // `authoring.ts`. `effort` is the lever, and changing it between turns
      // would invalidate the cached messages, so it is a constant.
      thinking: settings.thinking,
      output_config: settings.output_config,
    }),
  });

  // The status is known before any of the body is, which is the other half of
  // what streaming buys: a 401 for a key that has been revoked is answered
  // without waiting for a response that was never coming.
  if (!stream.ok) {
    throw new ModelApiError(stream.status, readErrorMessage(stream.text()));
  }

  try {
    return readModelStream(stream, userId, runId, summarising, mark);
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
  mark?: string,
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
  recordUsage(userId, runId, turn.usage, mark ?? "");

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
    { userId: userId },
    "subset",
  );
  turn.outbound = "";
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
      { user_id: userId, run_id: runId },
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
 * Whether this run has already told the person something.
 *
 * Asked only of a turn that produced nothing, to tell "it is finished" apart
 * from "it broke". Reading the activity rather than the conversation is
 * deliberate: compaction throws the conversation away and keeps the activity,
 * so a long run that answered an hour ago still answers this correctly.
 */
function alreadyAnswered(userId: string, runId: string): boolean {
  try {
    const rows = queryRows(
      "activities",
      { user_id: userId, run_id: runId, kind: "response" },
      1,
      "id",
      "desc",
    );
    return rows.length > 0;
  } catch (e) {
    // If we cannot tell, say no: a spurious "it said nothing" is a smaller
    // harm than a run that broke in silence.
    return false;
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

/**
 * What this run may do.
 *
 * Fails *closed*, which is the opposite of [`runStateOf`] and for the reason
 * that makes both right: there, "no row" had to mean the run carries on,
 * because work already accepted must not be abandoned over missing
 * bookkeeping. Here "no row" — or a row written before this column existed —
 * means the narrower of the two sets, because the cost of guessing wrong is
 * a write nobody approved rather than a turn that did not happen.
 */
function runModeOf(userId: string, runId: string): RunMode {
  const row = runRow(userId, runId);
  return String(row?.run_mode ?? "") === "act" ? "act" : "plan";
}

/** What this run is for. A run opened before kinds existed is a chat. */
function kindOf(userId: string, runId: string): RunKind {
  return runKindOf(runRow(userId, runId)?.run_kind);
}

/** The plan this run is waiting on, if it is waiting on one. */
function pendingPlan(userId: string, runId: string): PlanRow | null {
  if (!runId) return null;
  try {
    const rows = queryRows(
      "plans",
      { user_id: userId, run_id: runId, decision: "pending" },
      1,
      "id",
      "desc",
    ) as PlanRow[];
    return rows.length > 0 ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

/** Whether a run can still be spoken to or stopped. Absence means no. */
function runIsLive(userId: string, runId: string): boolean {
  const state = runStateOf(userId, runId);
  return state === "running" || state === "waiting";
}

function openRun(
  userId: string,
  runId: string,
  taskId: string,
  kind: string,
): void {
  const instructions = instructionsNow(userId);
  // A run without a row still runs; it just cannot be cancelled or counted.
  // Losing the answer to keep the bookkeeping would be the wrong way round,
  // so a failure here is logged and not raised.
  writeRow(
    () =>
      database.insert("runs", {
        user_id: userId,
        run_id: runId,
        run_state: "running",
        // Every run starts able to read and unable to write, which is what
        // `run_js` could already do — so this is not a new restriction on
        // anything, it is the floor the approval raises.
        run_mode: "plan",
        run_kind: kind,
        task_id: taskId,
        steps: 0,
        shared_instr: instructions.shared,
        own_instr: instructions.own,
        created_ms: Date.now(),
        updated_ms: Date.now(),
      }),
    "opening a run",
  );
}

/**
 * The deployment's instructions and the person's as they are now, for a
 * prompt to freeze. Either one unreadable is none: a turn without them is
 * better than no turn.
 */
function instructionsNow(userId: string): Instructions {
  return {
    shared: tidyInstructions(
      readAssetText(SHARED_INSTRUCTIONS_FILE) ?? "",
      MAX_SHARED_INSTRUCTIONS_CHARS,
    ),
    own: ownInstructions(userId),
  };
}

/** What the person has told the agent to do in every conversation. */
function ownInstructions(userId: string): string {
  try {
    const rows = queryRows(
      "instructions",
      { user_id: userId },
      1,
      "id",
      "desc",
    ) as { body?: unknown }[];
    return rows.length > 0
      ? tidyInstructions(rows[0].body, MAX_OWN_INSTRUCTIONS_CHARS)
      : "";
  } catch (e) {
    console.log("agent: could not read instructions: " + String(e));
    return "";
  }
}

/** The instructions the run's latest prompt froze. */
function frozenInstructions(userId: string, runId: string): Instructions {
  const row = runRow(userId, runId);
  return {
    shared: String(row?.shared_instr ?? ""),
    own: String(row?.own_instr ?? ""),
  };
}

/**
 * Give a finished conversation its next prompt: running again, with the turn
 * budget of a fresh prompt, no leftover failure counts and the instructions
 * as they are now. Back in plan mode,
 * because an approval was for the plan it was given, not for what is asked
 * next.
 */
function reopenRun(
  userId: string,
  row: RunRow,
  taskId: string,
  spoken: number,
): void {
  const instructions = instructionsNow(userId);
  writeRow(
    () =>
      database.update("runs", Number(row.id), {
        run_state: "running",
        run_mode: "plan",
        task_id: taskId,
        steps: 0,
        step_base: spoken,
        shared_instr: instructions.shared,
        own_instr: instructions.own,
        nudges: 0,
        fail_sig: "",
        updated_ms: Date.now(),
      }),
    "continuing a run",
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
    () => database.update("runs", Number(row.id), patch),
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
      { user_id: userId, run_id: runId },
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
      database.delete("interjections", Number(row.id));
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
  const spoken = history.filter((m) => m.speaker === "assistant").length;
  return stepsSincePrompt(row ? row.steps : null, spoken, row?.step_base);
}

function countStep(userId: string, runId: string, taken: number): void {
  const row = runRow(userId, runId);
  if (!row) return;
  writeRow(
    () =>
      database.update("runs", Number(row.id), {
        steps: taken + 1,
        updated_ms: Date.now(),
      }),
    "counting a turn",
  );
}

/**
 * Whether this run's conversation should be folded up before the next turn.
 *
 * The thresholds and the rule are in `budget.ts`; what is here is the one
 * thing that needs a database — the largest prompt this run has sent, which
 * is read only when the row count has not already decided it.
 */
function needsCompacting(
  userId: string,
  runId: string,
  history: MessageRow[],
): boolean {
  if (history.length < 4 || history.length >= COMPACT_AT_ROWS) {
    return shouldCompact(history.length, 0);
  }
  return shouldCompact(history.length, runSpend(userId, runId).largestPrompt);
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
    database.transaction(() => {
      for (const row of history) {
        database.delete("messages", Number(row.id));
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
    });
  } catch (e) {
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
 * Keep what this turn sends before the conversation, once per version per
 * run, and return the version's mark for the turn's usage row.
 *
 * Failing to keep it is not failing the turn, for the reason `recordUsage`
 * gives: the inspect page loses a record, the person keeps their answer.
 */
function keepSentPrompt(
  userId: string,
  runId: string,
  parts: PromptPart[],
  toolList: ToolSpec[],
  settings: Record<string, unknown>,
): string {
  const mark = requestMark(parts, toolList, settings);
  try {
    const kept = queryRows(
      "sent_prompts",
      { user_id: userId, run_id: runId, mark: mark },
      1,
      "id",
      "asc",
    );
    if (kept.length === 0) {
      database.insert("sent_prompts", {
        user_id: userId,
        run_id: runId,
        mark: mark,
        system_parts: JSON.stringify(parts),
        tools: JSON.stringify(toolList),
        settings: JSON.stringify(settings),
        created_ms: Date.now(),
      });
    }
  } catch (e) {
    console.log("agent: could not keep what a turn sent: " + String(e));
  }
  return mark;
}

/**
 * Keep what this turn spent, and tell the person's open tabs.
 *
 * Written as one row per turn rather than a running total updated in place.
 * Appending cannot lose an earlier turn to a read-modify-write, and the sum
 * of twelve rows is not worth a column — the step ceiling is the bound on how many
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
function recordUsage(
  userId: string,
  runId: string,
  usage: StreamUsage,
  mark: string,
): void {
  const cached = usage.cache_read_input_tokens ?? 0;
  const wrote = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  if (cached + wrote + fresh + output === 0) return;

  try {
    database.insert("turn_usage", {
      user_id: userId,
      run_id: runId,
      cached_tokens: cached,
      wrote_tokens: wrote,
      fresh_tokens: fresh,
      out_tokens: output,
      prompt_mark: mark,
      created_ms: Date.now(),
    });
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
    { userId: userId },
    "subset",
  );
}

/** What one run has spent, read back from the rows its turns wrote. */
function runSpend(userId: string, runId: string) {
  if (!runId) return emptySpend();
  try {
    return spendOf(
      queryRows(
        "turn_usage",
        { user_id: userId, run_id: runId },
        MOST_STEPS + 1,
        "id",
        "asc",
      ),
    );
  } catch (e) {
    // A page that cannot say what a run cost is better than a page that will
    // not load.
    return emptySpend();
  }
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

function listAssetInfo(): FileInfo[] {
  try {
    return files.list();
  } catch (e) {
    return [];
  }
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
  const skillFiles: FileInfo[] = [];
  for (const asset of listAssetInfo()) {
    if (skillNameOf(asset.path) !== null) skillFiles.push(asset);
  }
  if (skillFiles.length === 0) return [];

  skillFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const capped = skillFiles.slice(0, MAX_SKILLS);

  const marks: string[] = [];
  for (const file of capped) {
    marks.push(file.path + "@" + String(file.updatedAt ?? 0));
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
    const name = skillNameOf(file.path);
    if (name === null) continue;
    const text = readAssetText(file.path);
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
/** An asset's content as text, or null if it is not there. */
function readAssetText(name: string): string | null {
  try {
    return files.read(name);
  } catch (e) {
    // Not text, or not readable by this caller: either way there is no
    // skill to load from it.
    return null;
  }
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
/**
 * The tool list for one turn.
 *
 * Both conditions are properties of the run rather than of the turn — the
 * skill library does not change while a run is going, and the mode changes
 * once at most — so the list is as stable across a run as the rest of the
 * cached prefix, which is what a breakpoint at the end of the conversation
 * needs it to be.
 */
function toolsFor(skills: Skill[], mode: RunMode, kind: RunKind): ToolSpec[] {
  // A run that builds a script has its own short list, bound to the scripts
  // it creates: no discovering the engine's tools, no skills to write, no
  // notes. The less there is to choose between, the less a small model
  // chooses wrongly.
  if (kind === "author") {
    return [TOOLS[0]].concat(AUTHOR_TOOLS as unknown as ToolSpec[]);
  }
  let tools = TOOLS;
  // A property of the grant rather than of the turn, so it is as stable
  // across a run as the rest of the cached prefix — a person does not
  // withdraw a delegation mid-run, and if they do the next call refuses
  // rather than the tool list changing underneath a cached prefix.
  if (hasEngineAuthority()) {
    tools = tools.concat([ENGINE_TOOLS_TOOL, ENGINE_CALL_TOOL]);
  }
  if (hasAppAuthority()) {
    tools = tools.concat([APP_TOOLS_TOOL, APP_CALL_TOOL]);
  }
  if (mode === "plan") tools = tools.concat([REQUEST_APPROVAL_TOOL]);
  if (skills.length > 0) tools = tools.concat([READ_SKILL_TOOL]);
  // Not conditional on the library existing, unlike reading: the first skill
  // has to come from somewhere, and a deployment with none is exactly where
  // writing one is most useful.
  tools = tools.concat([WRITE_SKILL_TOOL]);
  return tools;
}

/**
 * Whether this execution can reach the engine's management tools at all.
 *
 * Two things have to be true and neither is this script's to decide. The
 * engine installs `engine` only where the authority came from a credential —
 * a request, or a delegated task — so a scheduled job and a `sandbox.run`
 * sub-execution do not have it. And the person has to have granted `author`
 * or `administer` on the consent page, which is what puts a management
 * capability in the delegated context.
 *
 * `sandbox.held()` answers the second cheaply and exactly: it reports what
 * *this* execution holds, so there is no need to call a tool and read its
 * refusal to find out.
 */
function hasEngineAuthority(): boolean {
  if (typeof engine === "undefined") return false;
  try {
    const held = sandbox.held();
    return (
      held.indexOf("administer_engine") !== -1 ||
      held.indexOf("write_scripts") !== -1
    );
  } catch (e) {
    // Reading what we hold should not be the thing that breaks a run.
    console.log("agent: could not read held capabilities: " + String(e));
    return false;
  }
}

/**
 * Whether this execution may call the tools other scripts publish.
 *
 * `call_tools` is held by a person's own request, and by a delegated run only
 * when they ticked "Use your other apps' tools" on the consent page — the
 * engine decides, and `sandbox.held()` reports it.
 */
function hasAppAuthority(): boolean {
  if (typeof tools === "undefined") return false;
  try {
    return sandbox.held().indexOf("call_tools") !== -1;
  } catch (e) {
    console.log("agent: could not read held capabilities: " + String(e));
    return false;
  }
}

/**
 * The system prompt for a turn, as labelled parts. Joined, they are what the
 * model is sent; apart, they are what the inspect page shows, each with why
 * this turn has it.
 */
function systemPartsFor(
  skills: Skill[],
  mode: RunMode,
  kind: RunKind,
  instructions: Instructions,
): PromptPart[] {
  const told = instructionParts(instructions.shared, instructions.own, kind);
  if (kind === "author") {
    return [
      {
        key: "author",
        label: "How to build a script",
        why: "This conversation builds a script, so it has its own instructions and tools.",
        sep: "",
        text: AUTHOR_PROMPT,
      },
      {
        key: "answer",
        label: "How to answer",
        why: "Every run answers through write_response.",
        sep: "\n",
        text: "Answer by calling write_response; that is how the person sees what you say.",
      },
    ].concat(told);
  }

  const parts: PromptPart[] = [
    {
      key: "base",
      label: "Instructions every run gets",
      why: "Always sent.",
      sep: "",
      text: SYSTEM_PROMPT,
    },
    mode === "act"
      ? {
          key: "mode",
          label: "Act mode",
          why: "A plan in this conversation was approved, so it may now change things.",
          sep: " ",
          text:
            "Your plan has been approved, so run_js can now write to this " +
            "person's stored notes. Reading them is still recall and " +
            "list_memories, in act mode as in plan. Do what you said you would " +
            "do and nothing wider — the approval was for that plan.",
        }
      : {
          key: "mode",
          label: "Plan mode",
          why: "No plan has been approved yet, so the run may read but not change anything.",
          sep: " ",
          text:
            "You can read, fetch and compute, but you cannot change anything " +
            "yet. If what you have been asked for needs writing, work out what " +
            "you intend to do and call request_approval with it; the run stops " +
            "until the person answers. Never tell the person you have saved or " +
            "changed something you have not. remember counts as a change: " +
            "calling it here pauses the run and asks on your behalf, so use it " +
            "normally and expect to be interrupted. Anything that only reads — " +
            "recall and list_memories included — just do.",
        },
  ];
  if (hasEngineAuthority()) {
    parts.push({
      key: "engine",
      label: "The engine's management tools",
      why: "You allowed this agent to author or administer on the permissions page.",
      sep: " ",
      text: ENGINE_PROMPT,
    });
  }
  if (hasAppAuthority()) {
    parts.push({
      key: "apps",
      label: "Your other apps' tools",
      why: "You allowed this agent to use your other apps' tools on the permissions page.",
      sep: " ",
      text: APP_PROMPT,
    });
  }
  if (skills.length > 0) {
    parts.push({
      key: "skills-use",
      label: "How to use skills",
      why: "This agent has skills.",
      sep: "\n\n",
      text:
        "Skills are instructions for particular kinds of work. When one covers " +
        "what you have been asked to do, call read_skill and follow it before " +
        "you start. Read at most the ones you need.",
    });
  }
  // Said whether or not any exist, because the first one has to come from
  // somewhere and a deployment with none is where writing one pays most.
  parts.push({
    key: "skills-write",
    label: "Writing skills",
    why: "Always sent, so the first skill can be written.",
    sep: skills.length > 0 ? " " : "\n\n",
    text:
      "If you work out a procedure worth repeating — the steps, the gotchas, " +
      "the thing you got wrong first — write it down with write_skill so every " +
      "future run does it the same way. That is for how to do work, not for " +
      "facts about the person, which are remember's job. It always pauses and " +
      "asks, because a skill changes this agent for everyone.",
  });
  if (skills.length > 0) {
    parts.push({
      key: "skills-index",
      label: "The skill list",
      why: "Each skill's name and description; the model reads a skill's body only when it needs it.",
      sep: "\n\n",
      text: skills
        .map((skill) => "- " + skill.name + ": " + skill.description)
        .join("\n"),
    });
  }
  return parts.concat(told);
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
      // And to the chat it came from, when it came from one. A no-op for a
      // run started on the page.
      notifyChannel(userId, runId, text);
      return { content: "Delivered.", isError: false };
    }

    case "write_image": {
      const caption = String(input.caption ?? "").trim();
      const rendered = renderSvg(String(input.svg ?? ""));
      if ("error" in rendered) {
        return {
          content: `${rendered.error}\nFix the SVG and call write_image again.`,
          isError: true,
        };
      }
      showPicture(userId, runId, rendered.png, caption);
      return { content: "Shown to the person.", isError: false };
    }

    case "remember": {
      const key = String(input.key ?? "").trim();
      const value = String(input.value ?? "");
      if (!key) return { content: "A key is required.", isError: true };

      // The one gate in this file that is policy rather than capability, and
      // the difference is worth being honest about. `run_js` is refused
      // *underneath* the JavaScript, by a context that does not hold
      // `write_storage`; this is refused by the script, because the turn
      // running it legitimately holds that capability — the agent's own
      // bookkeeping needs it. So this check is only as good as this file,
      // where that one is enforcement.
      //
      // It is here anyway because the alternative is a claim that is not
      // true. A person reading "Waiting for you" takes it to mean nothing
      // has been written, and a plan mode that stopped arbitrary code while
      // leaving a note-writing tool open would be telling them so falsely.
      //
      // It *asks* rather than refusing, and that is the part worth keeping.
      // Refusing and naming the recovery is the shape every other error in
      // this file takes, and it is the one place that shape failed: asked to
      // remember a preference, the model met the refusal, decided out loud
      // that "no approval needed since I'll just act on it directly", and
      // told the person it had noted something it had not. A refusal is an
      // instruction and an instruction can be argued with. Raising the
      // request from inside the tool cannot be, because by the time the
      // model reads an answer the run is already suspended.
      //
      // It also produces a better plan than the model would have written:
      // the key and the value are known exactly here, so the person is shown
      // the note itself rather than a paraphrase of an intention.
      if (runModeOf(userId, runId) === "plan") {
        return requestApprovalTool(
          userId,
          runId,
          `Remember "${key}":\n\n${value}`,
          "remember",
          { key: key, value: value },
        );
      }

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

    case "engine_tools": {
      return engineToolsTool(String(input.area ?? ""));
    }

    case "engine_call": {
      return engineCallTool(
        userId,
        runId,
        String(input.name ?? "").trim(),
        String(input.args ?? "{}"),
      );
    }

    case "app_tools": {
      return appToolsTool(String(input.area ?? ""));
    }

    case "app_call": {
      return appCallTool(
        userId,
        runId,
        String(input.name ?? "").trim(),
        String(input.args ?? "{}"),
      );
    }

    case "request_approval": {
      return requestApprovalTool(userId, runId, String(input.plan ?? ""));
    }

    case "write_skill": {
      return writeSkillTool(
        userId,
        runId,
        String(input.name ?? "").trim(),
        String(input.description ?? "").trim(),
        String(input.body ?? ""),
      );
    }

    case "read_skill": {
      return readSkillTool(
        String(input.name ?? "").trim(),
        String(input.file ?? "").trim() || SKILL_FILE,
      );
    }

    default:
      if (isAuthorTool(name) && kindOf(userId, runId) === "author") {
        return authorTool(userId, runId, name, input);
      }
      return { content: `No tool called "${name}".`, isError: true };
  }
}

/**
 * Propose a skill, and stop until somebody agrees to it.
 *
 * Every refusal names what would have worked, as everywhere else here; the
 * difference is that the accepted path also stops, because this tool cannot
 * do the thing it is for. See [`WRITE_SKILL_TOOL`] for why the write happens
 * at the approval rather than here.
 */
function writeSkillTool(
  userId: string,
  runId: string,
  name: string,
  description: string,
  body: string,
): { content: string; isError: boolean } {
  const lower = name.toLowerCase();
  if (!SKILL_NAME_PATTERN.test(lower)) {
    return {
      content: `"${name}" is not a usable skill name. Use lower case letters, digits and hyphens, starting with a letter or digit, up to 40 characters — the name is the folder it lives in.`,
      isError: true,
    };
  }
  if (!description) {
    return {
      content:
        "A description is required: one line saying when this skill applies, which is all you will see of it on a future turn when deciding whether to read it.",
      isError: true,
    };
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return {
      content: `That description is ${description.length} characters and sits in your instructions on every turn. Keep it under ${MAX_SKILL_DESCRIPTION_CHARS}.`,
      isError: true,
    };
  }
  if (!body.trim()) {
    return { content: "A skill with no body teaches nothing.", isError: true };
  }
  if (body.length > MAX_SKILL_CHARS) {
    return {
      content: `That body is ${body.length} characters, and a skill is capped at ${MAX_SKILL_CHARS}. Put the detail in the skill and the length somewhere else.`,
      isError: true,
    };
  }
  // A description spanning lines would break the front matter it goes into,
  // and silently: the parser reads one line per key.
  const oneLine = description.replace(/\s+/g, " ").trim();

  const known = loadSkills().map((s) => s.name);
  const replacing = known.indexOf(lower) !== -1;

  return requestApprovalTool(
    userId,
    runId,
    (replacing
      ? `Replace the skill "${lower}"`
      : `Write a new skill "${lower}"`) +
      ` — this changes what this agent does for everyone who uses it.\n\n` +
      `When it applies: ${oneLine}\n\n${body.trim()}`,
    "write_skill",
    { name: lower, description: oneLine, body: body.trim() },
  );
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
    if (asset.path === assetName) exists = true;
    if (asset.path.indexOf(folder) === 0) {
      siblings.push(asset.path.slice(folder.length));
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
 * What the model is given for what the person typed: `/<skill> words` becomes
 * the skill's instructions and the words, and anything else is unchanged. The
 * log keeps what they typed. A skill that cannot be read leaves the words as
 * they are, and the model, which has `read_skill`, can still try.
 */
function expandSkillCommand(text: string): string {
  if (text.indexOf("/") !== 0) return text;
  const command = parseCommand(
    text,
    loadSkills().map((s) => s.name),
  );
  if (command.command !== "skill") return text;
  const read = readSkillTool(command.skill, SKILL_FILE);
  if (read.isError) return text;
  return skillPrompt(command.skill, read.content, command.text);
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
/**
 * What this engine serves, asked of the engine rather than remembered here.
 */
function engineToolsTool(area: string): { content: string; isError: boolean } {
  if (typeof engine === "undefined") {
    return {
      content:
        "This run cannot reach the engine's management tools. They are available while somebody is using the agent, and to a run they have granted 'author' or 'administer' to.",
      isError: true,
    };
  }

  try {
    const listed = engine.tools(area.trim());
    if (!listed.tools || listed.tools.length === 0) {
      return {
        content: area.trim()
          ? `No management tool mentions "${area.trim()}". Call engine_tools with an empty area to see all of them.`
          : "This engine serves no management tools.",
        isError: false,
      };
    }
    const lines = listed.tools.map(
      (tool) => `${tool.name} — ${tool.description}`,
    );
    return {
      content: cut(
        `${listed.count} tool${listed.count === 1 ? "" : "s"}:\n` +
          lines.join("\n"),
        MAX_ENGINE_RESULT_CHARS,
      ),
      isError: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: `Could not list the tools: ${message}`, isError: true };
  }
}

/**
 * Call one management tool as the person whose run this is.
 *
 * Three refusals before the engine ever sees the call, and each is a different
 * thing to tell the model. Arguments that are not JSON are the model's
 * mistake and fixable on the next turn. A write while the run is planning is
 * the agent's own rule and names the tool that lifts it. And a tool that
 * refuses is the *person's* account saying no, which is not something to work
 * around — said plainly so the model reports it rather than retrying.
 */
function engineCallTool(
  userId: string,
  runId: string,
  name: string,
  argsJson: string,
): { content: string; isError: boolean } {
  if (typeof engine === "undefined") {
    return {
      content:
        "This run cannot reach the engine's management tools. Ask the person to grant this app 'administer' on their account page, then start a new run.",
      isError: true,
    };
  }
  if (!name) {
    return {
      content: "No tool was named. Put its name in `name`.",
      isError: true,
    };
  }

  const parsed = parseArgs(argsJson);
  if (!parsed.ok) {
    return {
      content: `\`args\` has to be a JSON object, e.g. {"script": "..."} — ${parsed.why}. Got: ${cut(argsJson, 200)}`,
      isError: true,
    };
  }
  const args = parsed.args;

  // The same line `run_js` draws, drawn for the same reason: reading is free
  // and changing is the thing a person is asked about. Withheld here rather
  // than relying on the engine to refuse, because the engine would *allow* it
  // — the person granted it — and the agent's plan step is what they are
  // actually expecting to be asked at.
  if (!onlyReads(name) && runModeOf(userId, runId) !== "act") {
    return {
      content: `${name} changes something, and this run has not been approved yet. Say what you intend to change with request_approval; if the person agrees you can call it on the turn after.`,
      isError: true,
    };
  }

  recordActivity(
    userId,
    runId,
    "engine",
    `${name} ${cut(JSON.stringify(args), 300)}`,
  );

  try {
    const answer = engine.call(name, args);
    return {
      content: cut(
        typeof answer === "string" ? answer : JSON.stringify(answer, null, 1),
        MAX_ENGINE_RESULT_CHARS,
      ),
      isError: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // An EngineError is the engine refusing or the arguments being wrong;
    // either way the model gets the engine's own words, which name the
    // capability or the argument rather than saying "failed".
    return { content: `${name}: ${message}`, isError: true };
  }
}

/**
 * What the person's apps publish, asked of the engine.
 *
 * Each line carries the argument schema, because a model calling a tool it
 * has only a name for guesses the arguments.
 */
function appToolsTool(area: string): { content: string; isError: boolean } {
  if (!hasAppAuthority()) {
    return {
      content:
        "This run cannot use the person's apps. Ask them to tick \"Use your other apps' tools\" under Change permissions, then start a new run.",
      isError: true,
    };
  }
  try {
    const listed = tools.list(area.trim());
    if (listed.length === 0) {
      return {
        content: area.trim()
          ? `No app tool mentions "${area.trim()}". Call app_tools with an empty area to see all of them.`
          : "None of the person's apps publish a tool.",
        isError: false,
      };
    }
    const lines = listed.map(
      (tool) =>
        `${tool.name} (${tool.script}) — ${tool.description}\n  args: ${JSON.stringify(tool.inputSchema ?? {})}`,
    );
    return {
      content: cut(
        `${listed.length} tool${listed.length === 1 ? "" : "s"}:\n` +
          lines.join("\n"),
        MAX_ENGINE_RESULT_CHARS,
      ),
      isError: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: `Could not list the tools: ${message}`, isError: true };
  }
}

/**
 * Call one app tool as the person whose run this is.
 *
 * Plan mode is enforced by the engine rather than asked of the model: an
 * unapproved run calls read-only, so the tool runs holding no write
 * capability and a change it attempts is refused underneath it. That is the
 * line `run_js` draws, and it needs no list of which app tools only read —
 * which nothing here could know.
 */
function appCallTool(
  userId: string,
  runId: string,
  name: string,
  argsJson: string,
): { content: string; isError: boolean } {
  if (!hasAppAuthority()) {
    return {
      content:
        "This run cannot use the person's apps. Ask them to tick \"Use your other apps' tools\" under Change permissions, then start a new run.",
      isError: true,
    };
  }
  if (!name) {
    return {
      content: "No tool was named. Put its name in `name`.",
      isError: true,
    };
  }
  const parsed = parseArgs(argsJson);
  if (!parsed.ok) {
    return {
      content: `\`args\` has to be a JSON object matching the tool's schema — ${parsed.why}. Got: ${cut(argsJson, 200)}`,
      isError: true,
    };
  }
  const args = parsed.args;
  const readOnly = runModeOf(userId, runId) !== "act";

  recordActivity(
    userId,
    runId,
    "app",
    `${name}${readOnly ? " (read-only)" : ""} ${cut(JSON.stringify(args), 300)}`,
  );

  try {
    const answer = tools.call(name, args, { readOnly });
    return {
      content: cut(
        typeof answer === "string" ? answer : JSON.stringify(answer, null, 1),
        MAX_ENGINE_RESULT_CHARS,
      ),
      isError: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      content:
        `${name}: ${message}` +
        (readOnly
          ? " (This run is not approved yet, so the tool ran read-only. If it needed to change something, propose the change with request_approval.)"
          : ""),
      isError: true,
    };
  }
}

// ============================================================================
// Building a script
// ============================================================================

type EngineAnswer =
  | { ok: true; value: Record<string, any> }
  | { ok: false; error: string };

/**
 * One engine operation, with refusals told apart from answers.
 *
 * Operations report a refusal as an object carrying `error` rather than by
 * throwing, so both forms are folded into one: callers read `ok`.
 */
function engineAnswer(
  name: string,
  args: Record<string, unknown>,
): EngineAnswer {
  if (typeof engine === "undefined") {
    return {
      ok: false,
      error:
        "This run cannot reach the engine. Ask the person to grant 'author'.",
    };
  }
  try {
    const raw = engine.call(name, args);
    const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
      string,
      any
    >;
    if (value && typeof value === "object" && value.error !== undefined) {
      const detail =
        typeof value.error === "string"
          ? value.error
          : String(value.error?.message ?? JSON.stringify(value.error));
      return {
        ok: false,
        error: detail + (value.message ? ` ${value.message}` : ""),
      };
    }
    return { ok: true, value: value ?? {} };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function failed(text: string): { content: string; isError: boolean } {
  return { content: text, isError: true };
}

function done(text: string): { content: string; isError: boolean } {
  return { content: text, isError: false };
}

/** The scripts this run created, which are the only ones its tools may touch. */
function createdScripts(userId: string, runId: string): string[] {
  const rows = queryRows(
    "run_scripts",
    { user_id: userId, run_id: runId },
    10,
    "id",
    "asc",
  ) as { script?: string }[];
  return rows.map((row) => String(row.script ?? "")).filter(Boolean);
}

/** Why a call may not touch `script`, or `null` when it may. */
function notYours(
  userId: string,
  runId: string,
  script: string,
): string | null {
  if (!script) return "A script name is required.";
  const own = createdScripts(userId, runId);
  if (own.indexOf(script) !== -1) return null;
  return own.length === 0
    ? "No script has been chosen in this run yet. Call create_script or open_script first."
    : `"${script}" is not the script this run works on. You may only work on ${own
        .map((name) => `"${name}"`)
        .join(", ")}.`;
}

function guideText(name: string): string {
  try {
    return files.read("authoring/" + name + ".md") ?? "";
  } catch (e) {
    return "";
  }
}

/** What a template file says once the script's own name is in it. */
function fillTemplate(text: string, name: string): string {
  return text
    .replace(/__NAME__/g, name)
    .replace(/__SNAKE__/g, name.replace(/-/g, "_"));
}

/** What a write answered about `init()`, in a sentence. */
function initSentence(init: Record<string, any> | undefined): string {
  if (!init) return "init() was not run.";
  if (init.ran === false) {
    return init.reason === "pinned"
      ? "init() not run: a placeholder is serving until you deploy, and the check below ran it as a dry run."
      : `init() not run (${String(init.reason ?? "")}).`;
  }
  return init.success === true
    ? "init() ran."
    : "init() FAILED: " + clip(String(init.error ?? ""), 400);
}

/**
 * Run an authoring tool, and leave a line on the activity log for a refusal.
 *
 * What a tool answered is otherwise only in the conversation, so a run that
 * kept being refused looked, from outside, like a run that kept calling the
 * same tool for no reason.
 */
function authorTool(
  userId: string,
  runId: string,
  name: string,
  input: Record<string, unknown>,
): { content: string; isError: boolean } {
  const outcome = runAuthorTool(userId, runId, name, input);
  if (outcome.isError) {
    recordActivity(
      userId,
      runId,
      "engine",
      `${name} refused: ${clip(outcome.content, 240)}`,
    );
  }
  return outcome;
}

function runAuthorTool(
  userId: string,
  runId: string,
  name: string,
  input: Record<string, unknown>,
): { content: string; isError: boolean } {
  if (name === "create_script") return createScriptTool(userId, runId, input);
  if (name === "open_script") return openScriptTool(userId, runId, input);

  const script = String(input.script ?? "").trim();
  const refusal = notYours(userId, runId, script);
  if (refusal) return failed(refusal);

  recordActivity(userId, runId, "engine", `${name} ${script}`);

  switch (name) {
    case "write_files": {
      const remove = readRemoveArgument(input.remove);
      // Files may be left out only when the call is just removing some.
      const given =
        input.files === undefined && remove.length > 0
          ? { files: [], problem: null }
          : readFilesArgument(input.files);
      if (given.problem) return failed(given.problem);
      const writes = given.files;
      const answer = engineAnswer("write_files", {
        script: script,
        files: writes,
        remove: remove,
      });
      if (!answer.ok) return failed(`write_files: ${answer.error}`);
      return reportWrite(userId, runId, script, answer.value, writes.length);
    }

    case "write_file": {
      const path = String(input.path ?? "").trim();
      if (!path) return failed("A 'path' is required.");
      if (typeof input.text !== "string") {
        return failed("'text' must be the file's whole contents, as a string.");
      }
      // Not checked here: the files of a script are written one at a time and
      // an early one imports a later one, so a check after each would report
      // faults that are only the work not being finished.
      const answer = engineAnswer("write_files", {
        script: script,
        files: [{ name: path, text: repairEscapedSource(input.text) }],
        check: false,
      });
      if (!answer.ok) return failed(`write_file: ${answer.error}`);
      return done(
        `Wrote ${path}` +
          (answer.value.revision !== undefined && answer.value.revision !== null
            ? ` (revision ${answer.value.revision})`
            : "") +
          ". Not checked yet: call check_script when every file is written.",
      );
    }

    case "edit_file": {
      const path = String(input.path ?? "").trim();
      const oldString = String(input.old_string ?? "");
      const newString = String(input.new_string ?? "");
      const editArgs = (from: string, to: string) => ({
        script: script,
        path: path,
        edits: [
          {
            old_string: from,
            new_string: to,
            replace_all: input.replace_all === true,
          },
        ],
      });
      let answer = engineAnswer("edit_file", editArgs(oldString, newString));
      let note = "";
      if (!answer.ok && answer.error.indexOf("was not found") !== -1) {
        // The model edits from memory of a file it wrote some turns ago. If
        // the words are right and only the whitespace has drifted, apply the
        // edit to the file's own text; otherwise show what is really there.
        const file = engineAnswer("read_file", { script: script, path: path });
        const text =
          file.ok && typeof file.value.content === "string"
            ? file.value.content
            : null;
        if (text !== null) {
          const loose = looseEdit(text, oldString, newString);
          if (loose) {
            answer = engineAnswer(
              "edit_file",
              editArgs(loose.oldString, loose.newString),
            );
            note = "(old_string matched ignoring whitespace.)\n";
            recordActivity(
              userId,
              runId,
              "engine",
              `edit_file recovered: old_string matched ignoring whitespace in ${path}`,
            );
          } else {
            const near = nearestRegion(text, oldString);
            return failed(
              `edit_file: ${answer.error}.` +
                (near ? `\nThe closest text in ${path} is:\n${near}` : "") +
                "\nCopy old_string exactly from the file (read_file shows it), " +
                "or replace the whole file with write_file.",
            );
          }
        }
      }
      if (!answer.ok) return failed(`edit_file: ${answer.error}`);
      const written = reportWrite(userId, runId, script, answer.value, 1);
      return { content: note + written.content, isError: written.isError };
    }

    case "read_file": {
      const path = String(input.path ?? "").trim();
      if (!path) {
        const listed = engineAnswer("list_files", { script: script });
        if (!listed.ok) return failed(`list_files: ${listed.error}`);
        const names = ((listed.value.files ?? []) as { uri?: string }[]).map(
          (f) => String(f.uri ?? ""),
        );
        return done(names.join("\n"));
      }
      const answer = engineAnswer("read_file", { script: script, path: path });
      if (!answer.ok) return failed(`read_file: ${answer.error}`);
      const text =
        typeof answer.value.content === "string"
          ? answer.value.content
          : "(not a text file)";
      return done(cut(text, 6000));
    }

    case "check_script": {
      const answer = engineAnswer("check_script", { script: script });
      if (!answer.ok) return failed(`check_script: ${answer.error}`);
      const stop = trackVerdict(userId, runId, script, "check", answer.value);
      return stop ?? done(summariseCheck(answer.value));
    }

    case "run_tests": {
      const args: Record<string, unknown> = { script: script };
      const filter = String(input.filter ?? "").trim();
      if (filter) args.filter = filter;
      const answer = engineAnswer("run_tests", args);
      if (!answer.ok) return failed(`run_tests: ${answer.error}`);
      const stop = trackVerdict(userId, runId, script, "tests", answer.value);
      return stop ?? done(summariseTests(answer.value));
    }

    case "read_logs": {
      const args: Record<string, unknown> = { script: script, limit: 20 };
      const level = String(input.level ?? "").trim();
      if (level) args.level = level;
      const answer = engineAnswer("read_logs", args);
      if (!answer.ok) return failed(`read_logs: ${answer.error}`);
      const rows = (answer.value.logs ?? answer.value.entries ?? []) as {
        level?: string;
        message?: string;
      }[];
      if (!Array.isArray(rows) || rows.length === 0)
        return done("No log lines.");
      return done(
        rows
          .map((r) => `${r.level ?? ""} ${clip(String(r.message ?? ""), 300)}`)
          .join("\n"),
      );
    }

    case "list_revisions": {
      const args: Record<string, unknown> = {
        script: script,
        limit: Number(input.limit) > 0 ? Math.floor(Number(input.limit)) : 10,
      };
      const asset = String(input.asset ?? "").trim();
      if (asset) args.asset = asset;
      const answer = engineAnswer("list_revisions", args);
      if (!answer.ok) return failed(`list_revisions: ${answer.error}`);
      return done(clip(JSON.stringify(answer.value), 3000));
    }

    case "revert_script": {
      const revision = String(input.revision ?? "").trim();
      if (!revision) return failed("'revision' is required.");
      const answer = engineAnswer(
        "revert_script",
        revertScriptArgs(script, input),
      );
      if (!answer.ok) return failed(`revert_script: ${answer.error}`);
      return done(clip(JSON.stringify(answer.value), 3000));
    }

    case "list_tasks": {
      const answer = engineAnswer("list_tasks", { script: script, limit: 20 });
      if (!answer.ok) return failed(`list_tasks: ${answer.error}`);
      return done(clip(JSON.stringify(answer.value), 3000));
    }

    case "cancel_task": {
      const args = cancelTaskArgs(script, input);
      if (!args.task)
        return failed("'task' is required: an id from list_tasks.");
      const answer = engineAnswer("cancel_task", args);
      if (!answer.ok) return failed(`cancel_task: ${answer.error}`);
      return done(clip(JSON.stringify(answer.value), 1000));
    }

    case "list_secrets": {
      const answer = engineAnswer("list_secrets", { script: script });
      if (!answer.ok) return failed(`list_secrets: ${answer.error}`);
      return done(clip(JSON.stringify(answer.value.keys ?? []), 1000));
    }

    case "write_secret":
    case "delete_secret": {
      const asked = secretChange(
        name === "write_secret" ? "write" : "delete",
        script,
        input,
      );
      if (!asked.ok) return failed(asked.why);
      return requestApprovalTool(
        userId,
        runId,
        secretPlanText(asked.change),
        name,
        asked.change,
      );
    }

    case "get_git_status": {
      const answer = engineAnswer("get_git_status", { script: script });
      if (!answer.ok) return failed(`get_git_status: ${answer.error}`);
      return done(clip(JSON.stringify(answer.value), 1000));
    }

    case "push_to_git": {
      const status = engineAnswer("get_git_status", { script: script });
      if (!status.ok) return failed(`get_git_status: ${status.error}`);
      const asked = gitPush(script, status.value, input);
      if (!asked.ok) return failed(asked.why);
      return requestApprovalTool(
        userId,
        runId,
        gitPushText(asked.change, status.value.pinnedRevision),
        "push_to_git",
        asked.change,
      );
    }

    case "eval_script": {
      const source = String(input.source ?? "");
      if (!source.trim()) return failed("'source' is required.");
      const answer = engineAnswer("eval_script", evalScriptArgs(script, input));
      if (!answer.ok) return failed(`eval_script: ${answer.error}`);
      return done(clip(JSON.stringify(answer.value), 3000));
    }

    case "request_deploy":
      return requestDeployTool(
        userId,
        runId,
        script,
        String(input.summary ?? ""),
      );

    default:
      return failed(`No tool called "${name}".`);
  }
}

/**
 * Start a script from the shape's template, and pin the placeholder.
 *
 * The first thing written is a stub that registers nothing, and it is pinned at
 * once. Everything after that advances head while the stub keeps serving, so
 * a half-written script is never what visitors reach; the person's approval of
 * a deploy is what moves the pin.
 */
/**
 * Take an existing script as this run's one script.
 *
 * Two things are checked here rather than left to the engine. Ownership,
 * because a run holding `administer` could otherwise be pointed at a script
 * nobody here owns; and the pin, because an unpinned script serves head, so
 * the first write would go live without anyone being asked. Pinning at the
 * revision being served changes nothing visible and gives `request_deploy`
 * the same meaning it has for a new script.
 */
function openScriptTool(
  userId: string,
  runId: string,
  input: Record<string, unknown>,
): { content: string; isError: boolean } {
  const script = String(input.script ?? "").trim();
  if (!script) return failed("A script name is required.");
  if (createdScripts(userId, runId).length > 0) {
    return failed(
      "This run already has its script. Keep working on it with write_files.",
    );
  }
  const owners = engineAnswer("list_script_owners", { script: script });
  if (!owners.ok) return failed(`Could not check ownership: ${owners.error}`);
  const notOwned = notOpenable(script, owners.value.owners, userId);
  if (notOwned) return failed(notOwned);
  const listed = engineAnswer("list_files", { script: script });
  if (!listed.ok) return failed(`list_files: ${listed.error}`);
  const deployment = engineAnswer("get_deployment", { script: script });
  if (!deployment.ok) return failed(`get_deployment: ${deployment.error}`);
  if (deployment.value.pinned !== true) {
    const pin = engineAnswer("deploy_script", {
      script: script,
      revision: "head",
    });
    if (!pin.ok) {
      return failed(`Could not hold what is served: ${pin.error}`);
    }
  }
  writeRow(
    () =>
      database.insert("run_scripts", {
        user_id: userId,
        run_id: runId,
        script: script,
        created_ms: Date.now(),
      }),
    "recording an opened script",
  );
  recordActivity(userId, runId, "tool", `Opened the script "${script}".`);
  const paths = ((listed.value.files ?? []) as { uri?: string }[])
    .map((f) => String(f.uri ?? ""))
    .filter(Boolean);
  return done(
    [
      `Opened "${script}". What it serves now stays as it is; nothing you write is served until you call request_deploy and the person approves.`,
      `Files: ${paths.join(", ")}.`,
      "Read the files you will change before writing, and keep what the request does not ask you to change.",
    ].join("\n"),
  );
}

function createScriptTool(
  userId: string,
  runId: string,
  input: Record<string, unknown>,
): { content: string; isError: boolean } {
  const name = String(input.name ?? "")
    .trim()
    .toLowerCase();
  const shape = String(input.shape ?? "").trim();
  const problem = scriptNameProblem(name);
  if (problem) return failed(problem);
  if (!isShape(shape)) {
    return failed(`shape must be one of: site, tool, agent. Got "${shape}".`);
  }
  if (createdScripts(userId, runId).length > 0) {
    return failed(
      "This run already has its script. Keep working on it with write_files.",
    );
  }
  // `list_files` answers a script that does not exist with no files rather
  // than with an error, so what says it exists is that it has some.
  const existing = engineAnswer("list_files", { script: name });
  if (existing.ok && ((existing.value.files ?? []) as unknown[]).length > 0) {
    return failed(
      `A script called "${name}" already exists. Choose another name.`,
    );
  }

  const template = templateScriptFor(shape);
  const listed = engineAnswer("list_files", { script: template });
  if (!listed.ok) {
    return failed(
      `The ${shape} template is not installed on this engine (a script called "${template}"). ` +
        'Tell the person to pull it: pull_from_git lpajunen/aiwebengine-template with prefix "template".',
    );
  }
  const starter = ((listed.value.files ?? []) as { uri?: string }[])
    .map((f) => String(f.uri ?? ""))
    .filter((path) => path.indexOf("starter/") === 0);
  if (starter.length === 0) {
    return failed(`The ${shape} template has no starter files.`);
  }

  const copies: { name: string; text: string }[] = [];
  for (const path of starter) {
    const file = engineAnswer("read_file", { script: template, path: path });
    if (!file.ok || typeof file.value.content !== "string") continue;
    copies.push({
      name: path.slice("starter/".length),
      text: fillTemplate(file.value.content, name),
    });
  }

  // The stub first, and pinned: see above.
  const stub = engineAnswer("write_files", {
    script: name,
    files: [{ name: "main.ts", text: STUB_SOURCE }],
    check: false,
  });
  if (!stub.ok) return failed(`Could not create the script: ${stub.error}`);
  const pin = engineAnswer("deploy_script", { script: name, revision: "head" });
  if (!pin.ok) return failed(`Could not hold the placeholder: ${pin.error}`);

  writeRow(
    () =>
      database.insert("run_scripts", {
        user_id: userId,
        run_id: runId,
        script: name,
        created_ms: Date.now(),
      }),
    "recording a created script",
  );
  recordActivity(
    userId,
    runId,
    "tool",
    `Created the script "${name}" (${shape}).`,
  );

  const written = engineAnswer("write_files", { script: name, files: copies });
  if (!written.ok)
    return failed(`Could not copy the starter: ${written.error}`);

  return done(
    [
      `Created "${name}" from the ${shape} starter. A placeholder is serving; nothing you write is served until you call request_deploy and the person approves.`,
      `Starter files: ${copies.map((c) => c.name).join(", ")}.`,
      initSentence(written.value.init),
      summariseCheck(written.value.check),
      "",
      "Read the primer and the guide, then change the starter to do what was asked. Use the exact file, function, route and tool names the request gives, and delete the placeholder files.",
      "",
      guideText("primer"),
      "",
      guideText("build-" + shape),
    ].join("\n"),
  );
}

/** The answer to a write: what changed, what `init()` did, and the check. */
function reportWrite(
  userId: string,
  runId: string,
  script: string,
  value: Record<string, any>,
  count: number,
): { content: string; isError: boolean } {
  const stop = trackVerdict(userId, runId, script, "check", value.check);
  if (stop) return stop;
  return done(
    [
      `Wrote ${count} file(s)` +
        (value.revision !== undefined && value.revision !== null
          ? ` (revision ${value.revision}).`
          : "."),
      initSentence(value.init),
      value.check ? summariseCheck(value.check) : "check: not run",
    ].join("\n"),
  );
}

/**
 * Count a verdict, and stop the run if the same failure keeps coming back.
 *
 * Returns a tool result only when the run has been stopped, which the caller
 * hands to the model in place of the verdict.
 */
function trackVerdict(
  userId: string,
  runId: string,
  script: string,
  kind: string,
  report: unknown,
): { content: string; isError: boolean } | null {
  if (report === undefined || report === null) return null;
  const row = runRow(userId, runId);
  if (!row) return null;
  let counts: Record<string, { sig: string; count: number } | null> = {};
  try {
    counts = JSON.parse(String(row.fail_sig ?? "") || "{}");
  } catch (e) {
    counts = {};
  }
  const next = nextFailureCount(
    counts[kind] ?? null,
    failureSignature(kind, report),
  );
  counts[kind] = next;
  writeRow(
    () =>
      database.update("runs", Number(row.id), {
        fail_sig: JSON.stringify(counts),
        updated_ms: Date.now(),
      }),
    "counting a failure",
  );
  if (!shouldEscalate(next)) return null;

  const verdict =
    kind === "check" ? summariseCheck(report) : summariseTests(report);
  escalate(
    userId,
    runId,
    script,
    `The same ${kind === "check" ? "check" : "test"} failure came back ${ESCALATE_AT} times, so I am stopping rather than trying again.`,
    verdict,
  );
  finishRun(userId, runId, "handoff");
  return failed(
    "Stopped: the same failure came back three times. A note for a developer has been written; do nothing more.",
  );
}

/** Write the handoff note where the person will read it. */
function escalate(
  userId: string,
  runId: string,
  script: string,
  reason: string,
  lastVerdict: string,
): void {
  const prompts = queryRows(
    "activities",
    { user_id: userId, run_id: runId, kind: "prompt" },
    1,
    "id",
    "asc",
  ) as { message?: string }[];
  const steps = queryRows(
    "activities",
    { user_id: userId, run_id: runId, kind: "engine" },
    40,
    "id",
    "desc",
  ) as { message?: string }[];
  let revision = "";
  if (script) {
    const revisions = engineAnswer("list_revisions", {
      script: script,
      limit: 1,
    });
    if (revisions.ok) {
      const head = (revisions.value.revisions ?? [])[0];
      if (head) revision = String(head.revision ?? "");
    }
  }
  const note = handoffNote({
    request: String(prompts[0]?.message ?? ""),
    script: script || createdScripts(userId, runId)[0] || "",
    revision: revision,
    lastVerdict: lastVerdict,
    tried: steps
      .slice(0, 8)
      .reverse()
      .map((row) => String(row.message ?? "")),
    reason: reason,
  });
  recordActivity(userId, runId, "response", note);
  notifyChannel(userId, runId, note);
}

/**
 * Ask the person to approve serving the script, once it is worth asking.
 *
 * The check and the tests run here rather than being trusted from earlier: the
 * person is shown the verdict the deploy would rest on, and a script that does
 * not pass is refused before anybody is asked.
 */
function requestDeployTool(
  userId: string,
  runId: string,
  script: string,
  summary: string,
): { content: string; isError: boolean } {
  // Placeholders first: a script whose logic sits in the starter's
  // `lib/example.ts` passes everything else and still is not what was asked.
  const listed = engineAnswer("list_files", { script: script });
  if (listed.ok) {
    const paths = ((listed.value.files ?? []) as { uri?: string }[]).map((f) =>
      String(f.uri ?? ""),
    );
    const left = leftoverPlaceholders(paths);
    const instructions = engineAnswer("read_file", {
      script: script,
      path: "skills/instructions.md",
    });
    if (
      instructions.ok &&
      String(instructions.value.content ?? "").indexOf(
        INSTRUCTIONS_PLACEHOLDER,
      ) !== -1
    ) {
      left.push("skills/instructions.md (still the starter's text)");
    }
    if (left.length > 0) {
      return failed(
        "Not ready to deploy: the starter's placeholders are still here: " +
          left.join(", ") +
          ". Put your code in the files the request names (use write_files with " +
          "those paths), and remove the placeholders with 'remove'.",
      );
    }
  }
  const check = engineAnswer("check_script", { script: script });
  if (!check.ok) return failed(`check_script: ${check.error}`);
  const tests = engineAnswer("run_tests", { script: script });
  if (!tests.ok) return failed(`run_tests: ${tests.error}`);
  const checkText = summariseCheck(check.value);
  const testsText = summariseTests(tests.value);
  if (check.value.ok !== true || !testsPassed(tests.value)) {
    trackVerdict(userId, runId, script, "check", check.value);
    return failed(
      "Not ready to deploy. Fix this first:\n" + checkText + "\n" + testsText,
    );
  }
  return requestApprovalTool(
    userId,
    runId,
    `Deploy "${script}" — this makes it live.\n\n${summary.trim()}\n\n${checkText}\n${testsText}`,
    "deploy_script",
    { script: script },
  );
}

/**
 * Move the pin to head, which is the whole of a deploy.
 *
 * Runs at the approval, in the person's own request, so the script is served
 * only when they said so. The script is looked up again against what this run
 * created: an approval row carries a name, and a name is not authority.
 */
/**
 * Publish, at the approval, to the place the person was shown.
 *
 * The status is read again here: an approval can sit for hours, and what the
 * person agreed to was a push to that repository and branch from a script
 * that was ahead of it. If either has changed, nothing is pushed.
 */
function performGitPush(
  userId: string,
  runId: string,
  plan: PlanRow,
): string | null {
  const change = gitPushFrom(plan.payload);
  if (!change) return null;
  const refusal = notYours(userId, runId, change.script);
  if (refusal) return refusal;
  const status = engineAnswer("get_git_status", { script: change.script });
  if (!status.ok) return `it was not pushed: ${status.error}`;
  if (
    status.value.state !== "ahead" ||
    status.value.repo !== change.repo ||
    status.value.branch !== change.branch
  ) {
    const why = `the script is now ${String(status.value.state)} against ${String(status.value.repo)} on ${String(status.value.branch)}, not what you approved`;
    recordActivity(userId, runId, "error", `Not pushed: ${why}.`);
    return `it was not pushed: ${why}`;
  }
  const answer = engineAnswer("push_to_git", pushToGitArgs(change));
  if (!answer.ok) {
    recordActivity(userId, runId, "error", `Could not push: ${answer.error}`);
    return `it could not be pushed: ${answer.error}`;
  }
  recordActivity(
    userId,
    runId,
    "tool",
    `Pushed "${change.script}" to ${change.repo} on ${change.branch}.`,
  );
  return `"${change.script}" is pushed to ${change.repo} on ${change.branch}`;
}

function performSecretChange(
  userId: string,
  runId: string,
  plan: PlanRow,
): string | null {
  const change = secretChangeFrom(plan.payload);
  if (!change) return null;
  const refusal = notYours(userId, runId, change.script);
  if (refusal) return refusal;
  const writing = change.value !== undefined;
  const answer = engineAnswer(
    writing ? "write_secret" : "delete_secret",
    writing
      ? { script: change.script, key: change.key, value: change.value }
      : { script: change.script, key: change.key },
  );
  // The key is the whole of what the log says: the value stays out of it.
  if (!answer.ok) {
    recordActivity(
      userId,
      runId,
      "error",
      `Could not ${writing ? "store" : "remove"} the secret "${change.key}": ${answer.error}`,
    );
    return `it could not be ${writing ? "stored" : "removed"}: ${answer.error}`;
  }
  recordActivity(
    userId,
    runId,
    "tool",
    `${writing ? "Stored" : "Removed"} the secret "${change.key}" of "${change.script}".`,
  );
  return `the secret "${change.key}" is ${writing ? "stored" : "removed"}`;
}

function performDeploy(
  userId: string,
  runId: string,
  plan: PlanRow,
): string | null {
  let script = "";
  try {
    script = String(
      (JSON.parse(String(plan.payload ?? "")) as { script?: string }).script ??
        "",
    );
  } catch (e) {
    return null;
  }
  const refusal = notYours(userId, runId, script);
  if (refusal) return refusal;
  const answer = engineAnswer("deploy_script", {
    script: script,
    revision: "head",
  });
  if (!answer.ok) {
    recordActivity(userId, runId, "error", `Could not deploy: ${answer.error}`);
    return `it could not be deployed: ${answer.error}`;
  }
  recordActivity(userId, runId, "tool", `Deployed "${script}".`);
  return `"${script}" is deployed and now serving`;
}

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

  // Read per call rather than passed in, because it can change between one
  // turn and the next: an approval lands while the run is suspended, and the
  // turn after holds more than the turn before did.
  const granted = capabilitiesFor(runModeOf(userId, runId));

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
 * Put a plan to the person and stop the run until they answer.
 *
 * The suspending half needed no new machinery, which was the whole argument
 * for building the stopping half once: `advanceRun` already re-reads the run's
 * state after its tools have run and declines to queue a successor unless it
 * is still `running`. So setting `waiting` here *is* the suspend — the turn
 * finishes, its `tool_result` is stored beside the `tool_use` that asked for
 * it, and nothing queues the next one. The conversation is left at a point it
 * can legally resume from, which is why this must be a tool and not, say, a
 * stop reason read off the model's prose.
 *
 * The state is written first and the record second. If the run was cancelled
 * while this turn was thinking, the transition fails and there is no plan row
 * asking a person to decide something that has already been abandoned.
 */
function requestApprovalTool(
  userId: string,
  runId: string,
  plan: string,
  action?: string,
  payload?: unknown,
): { content: string; isError: boolean } {
  const body = plan.trim();
  if (!body) {
    return {
      content:
        "A plan is required: say what you intend to do, in words the person can agree or disagree with.",
      isError: true,
    };
  }

  if (runModeOf(userId, runId) === "act") {
    // The tool is withdrawn in `act`, so this is only reachable if the model
    // replayed an earlier call. Answering plainly beats refusing.
    return {
      content:
        "Your plan is already approved — you can write. Carry on and do it.",
      isError: false,
    };
  }

  if (!setRunState(userId, runId, "waiting", undefined, "running")) {
    return {
      content:
        "This run is no longer running, so there is nobody to ask. Stop here.",
      isError: true,
    };
  }

  writeRow(
    () =>
      database.insert("plans", {
        user_id: userId,
        run_id: runId,
        body: body,
        action: action ?? "",
        payload: payload === undefined ? "" : JSON.stringify(payload),
        decision: "pending",
        note: "",
        created_ms: Date.now(),
        decided_ms: 0,
      }),
    "recording a plan",
  );

  recordActivity(userId, runId, "plan", body);

  // The same question, in the place the person actually is. Two buttons
  // rather than a link back to the page, because a plan that can only be
  // answered at a browser defeats the point of reaching somebody on their
  // phone — and `decide` moves the run identically either way.
  notifyChannel(userId, runId, body, {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `approve:${runId}` },
        { text: "Reject", callback_data: `reject:${runId}` },
      ],
    ],
  });

  return {
    content: action
      ? "Paused. The person has been shown exactly what this would do and the run stops here until they answer. " +
        "If they approve it is carried out for you, so do not repeat the call; if they reject, you will be told why."
      : "Paused. The person has been shown your plan and the run stops here until they answer. " +
        "If they approve, your next turn can write; if they reject, you will be told why.",
    isError: false,
  };
}

/**
 * Write the skill a person approved.
 *
 * The one deferred action that can fail for a reason worth explaining rather
 * than logging. `write_files` is editor-tier and ownership-checked, and a
 * delegated task is capped below it — so this succeeds when the approval came
 * from the page, in the person's own request, and is **refused when it came
 * from a Telegram button**, which runs as a queued task.
 *
 * That is the engine's rule holding rather than a gap: authoring a solution
 * is not something background work may do, and approving from a phone is
 * background work. Saying so beats a refusal the person cannot place.
 *
 * `upsertAsset` reports refusal by *returning* a message rather than throwing,
 * which is why the answer is inspected rather than merely awaited.
 */
function performSkillWrite(
  userId: string,
  runId: string,
  plan: PlanRow,
): string | null {
  const args = skillWriteArgs(plan.payload);
  if (!args) return null;
  const name = args.name;
  const file = renderSkillFile(name, args.description, args.body);

  try {
    files.write(skillAssetPath(name), file);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const why =
      message.indexOf("Insufficient capabilities") !== -1
        ? "writing a skill needs the rights to author this script, which a queued approval does not have — approve it on the agent page instead"
        : message;
    recordActivity(userId, runId, "error", `The skill was not written: ${why}`);
    return `it was not written: ${why}`;
  }

  // Said where the person is looking, because nothing else will tell them.
  // The write is recorded as a revision of this script, but a skill that lives
  // only in this engine is still one a pull from the repository deletes for
  // not being there.
  recordActivity(
    userId,
    runId,
    "tool",
    `Wrote the skill "${name}". It lives in this engine's assets — commit it to ` +
      `agent/skills/${name}/SKILL.md to keep it, if this deployment syncs from a repository.`,
  );
  return `the skill "${name}" is written`;
}

/**
 * Do the thing a person just approved.
 *
 * The reason this exists rather than letting the resumed model repeat its own
 * call: it does not repeat it. Asked to remember a preference, the model
 * raised the request, the person approved, the run resumed — and the next turn
 * answered "Done. I'll give you concise answers from now on" with no tool call
 * at all. Nothing was stored, and the person was told otherwise, which is the
 * same failure as before the approval existed and one step further from being
 * noticed.
 *
 * So a plan that defers a call carries that call, and approving it runs it.
 * That is also what the button means: the person pressed approve on the words
 * `Remember "x": y`, not on an intention to try again. Executing the stored
 * payload guarantees what happens is what was shown — the model cannot
 * paraphrase it, forget it, or decide it was satisfied by saying so.
 *
 * It runs here, in the person's own request, which is the one context where
 * `personalStorage` resolves to them.
 *
 * Returns what to tell the model, or null when there was nothing to do.
 */
function performApproved(
  userId: string,
  runId: string,
  plan: PlanRow,
): string | null {
  const action = String(plan.action ?? "");
  if (!action) return null;

  if (action === "write_skill") {
    return performSkillWrite(userId, runId, plan);
  }

  if (action === "deploy_script") {
    return performDeploy(userId, runId, plan);
  }

  if (action === "push_to_git") {
    return performGitPush(userId, runId, plan);
  }

  if (action === "write_secret" || action === "delete_secret") {
    return performSecretChange(userId, runId, plan);
  }

  if (action !== "remember") {
    // A plan naming something this version does not know how to do. Better to
    // say so than to resume as though it had been carried out.
    console.log(`agent: approved an unknown action "${action}"`);
    return null;
  }

  const args = rememberArgs(plan.payload);
  if (!args) return null;
  const key = args.key;

  try {
    personalStorage.setItem(NOTE_PREFIX + key, args.value);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordActivity(
      userId,
      runId,
      "error",
      `Could not store the note: ${message}`,
    );
    return `it could not be stored: ${message}`;
  }

  recordActivity(userId, runId, "tool", `Remembered "${key}".`);
  return `the note "${key}" is stored`;
}

/**
 * What `run_js` may actually be given: what this mode wants, that this turn
 * holds.
 *
 * A grant can be narrower than either list — a delegation that said read and
 * not write is still allowed to be one — and `sandbox.run` throws when asked
 * to keep something the caller does not have. So the list is a request rather
 * than an assertion, and an empty intersection still runs: code holding
 * nothing at all computes, which is the base case everything else is
 * subtracted from.
 *
 * Note what this means for an approved plan under a read-only delegation: the
 * person approved the plan and the *grant* still refuses the write. That is
 * the right order. An approval says what this run may attempt; the grant says
 * what the script may ever do as them, and one click cannot widen the other.
 */
function capabilitiesFor(mode: RunMode): Capability[] {
  let held: Capability[] = [];
  try {
    held = sandbox.held();
  } catch (e) {
    // Nothing to do but grant nothing. Code that can only compute is worth
    // more than a tool that refuses.
    console.log("agent: could not read what this turn holds: " + String(e));
    return [];
  }
  return withoutTheExfiltrationPair(
    wantedCapabilities(mode).filter((name) => held.indexOf(name) !== -1),
  );
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
// Telegram
// ============================================================================

const TELEGRAM_CHANNEL = "telegram";

/**
 * The bot token, as a *script* secret rather than a person's.
 *
 * It belongs to the deployment: every person messaging the bot is answered
 * through the same credential. `resolve_secret_db` reads user secrets first
 * and script secrets second, so a name nobody has stored personally resolves
 * to this one.
 *
 * It is a secret rather than a `scriptStorage` value: a token in
 * `scriptStorage` is a string this script can read, and therefore a string
 * that leaves with whatever reads it. Kept here it is never handed to
 * JavaScript at all, and is substituted host-side into a URL that reaches the
 * audit line as a template.
 */
const TELEGRAM_TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";

/**
 * The token Telegram echoes back in `X-Telegram-Bot-Api-Secret-Token`.
 *
 * In `scriptStorage`, which this script can read — and so anything running
 * as this script with `read_storage` can. `run_js` holds no `read_storage`.
 * `crypto.secretEquals` compares a stored secret without returning it, so
 * this can move to `secretStorage`; that is open work in
 * `TODO-improvements.md`, since it changes the setup instructions.
 *
 * What it is worth is bounded, which is what made that survivable. It
 * authenticates inbound calls and unlocks nothing outbound: somebody holding
 * it can pretend to be Telegram, but `enqueueFrom` still refuses a sender
 * nobody has linked, the run still belongs to whoever linked it, and the
 * per-link budget still applies. Losing it means forged messages from a
 * sender who already trusts this bot — not access to the bot, and not access
 * to anybody's account.
 */
const TELEGRAM_WEBHOOK_SECRET_KEY = "telegram:webhook_secret";

/**
 * The API base, with the token where Telegram insists on having it.
 *
 * This line is the reason `http_client.rs` grew URL substitution. Telegram
 * takes its token as a path segment and offers no header form, so before that
 * change this API was not reachable from a script holding the token safely.
 */
const TELEGRAM_API =
  "https://api.telegram.org/bot{{secret:" + TELEGRAM_TOKEN_SECRET + "}}/";

/** Where Telegram serves a file's bytes, once `getFile` has named its path. */
const TELEGRAM_FILE_API =
  "https://api.telegram.org/file/bot{{secret:" + TELEGRAM_TOKEN_SECRET + "}}/";

/**
 * Per chat, in the person's `personalStorage`: when they last sent `/new` on
 * its own, which no run marks because none has started yet. Outside
 * `NOTE_PREFIX`, so it is not one of their notes.
 */
const TELEGRAM_FRESH_PREFIX = "telegram:fresh:";

/**
 * Per chat, in the person's `personalStorage`: the `/` menu last given to
 * Telegram for it, so it is sent again only when the skills change.
 */
const TELEGRAM_MENU_PREFIX = "telegram:menu:";

/** Telegram refuses a message over 4096 characters. */
const MAX_TELEGRAM_CHARS = 3500;

interface TelegramChat {
  id?: number | string;
}

interface TelegramFrom {
  id?: number | string;
}

interface TelegramMessage {
  text?: string;
  /** The text sent with a photo or a document, which then has no `text`. */
  caption?: string;
  photo?: { file_id?: string; width?: number; height?: number }[];
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  chat?: TelegramChat;
  from?: TelegramFrom;
}

interface TelegramCallback {
  id?: string;
  data?: string;
  from?: TelegramFrom;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
}

/**
 * Log, if this execution is allowed to.
 *
 * The webhook runs anonymously — nobody is signed in when Telegram calls —
 * and the anonymous tier does not hold `view_logs`, so `console.log` is
 * refused there. Every other path in this file logs normally; this exists so
 * the shared Telegram helpers can be called from both without the webhook
 * failing on a diagnostic.
 */
function quietLog(message: string): void {
  try {
    console.log(message);
  } catch (e) {
    // No `view_logs` in this context. The message is not worth the turn.
  }
}

/** Send a message to a chat, optionally with buttons under it. */
function sendTelegram(
  chatId: string,
  text: string,
  keyboard?: unknown,
  quiet?: boolean,
): boolean {
  if (!chatId || !text.trim()) return false;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: cut(text, MAX_TELEGRAM_CHARS),
  };
  if (keyboard) body.reply_markup = keyboard;
  // No second buzz for a footnote to the message that just arrived.
  if (quiet) body.disable_notification = true;

  try {
    const answer = fetch(TELEGRAM_API + "sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!answer.ok) {
      // The body names the reason — a bad token, a chat the bot was removed
      // from — and none of it contains the token, which stayed in the URL the
      // engine substituted and never wrote down.
      quietLog(
        `agent: telegram refused a message: ${String(answer.body).slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    quietLog(`agent: could not reach telegram: ${String(e).slice(0, 200)}`);
    return false;
  }
}

/** Send a picture to a chat as a photo. */
function sendTelegramPhoto(
  chatId: string,
  png: string,
  caption: string,
): boolean {
  if (!chatId) return false;
  try {
    const answer = fetch(TELEGRAM_API + "sendPhoto", {
      method: "POST",
      form: telegramPhotoForm(chatId, png, caption),
    });
    if (!answer.ok) {
      quietLog(
        `agent: telegram refused a photo: ${String(answer.body).slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    quietLog(`agent: could not reach telegram: ${String(e).slice(0, 200)}`);
    return false;
  }
}

/**
 * Stop the spinner on a button the person just pressed.
 *
 * Telegram shows a loading state on an inline button until the bot
 * acknowledges the callback, so skipping this leaves the button looking stuck
 * whatever else went right.
 */
function answerCallback(callbackId: string, text: string): void {
  if (!callbackId) return;
  try {
    fetch(TELEGRAM_API + "answerCallbackQuery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text: text }),
    });
  } catch (e) {
    quietLog("agent: could not answer a telegram callback");
  }
}

/**
 * The webhook. Telegram calls this, and nobody is signed in when it does.
 *
 * Which is the whole difficulty, and the engine answers it rather than this
 * script: **a script cannot name whose agent runs.** There is no call here
 * that takes a user id. `personalTasks.enqueueFrom` names a *sender* — a
 * channel and an identity as that channel spells it — and the engine resolves
 * that against the links people have consented to. An unlinked sender
 * resolves to nobody and throws.
 *
 * So the worst this handler can do by trusting the wrong field of a body a
 * stranger posted is claim the *wrong sender*. It cannot name a different
 * account, and it cannot enumerate one.
 *
 * What this context holds is worth knowing before editing: the anonymous tier
 * has `use_network`, `read_secrets`, `read_storage` and `enqueue_tasks`, and
 * has **no database access and no `view_logs`**. That is why everything here
 * is a queue-and-reply and why the run itself is created by a task rather
 * than inline — creating it needs to write rows, and this execution cannot.
 *
 * Almost everything answers 200. Telegram retries anything that is not 2xx,
 * and a retry loop over a message this bot has already refused helps nobody;
 * what went wrong is said in the chat instead.
 */
function handleTelegram(context: HandlerContext): HttpResponse {
  if (!telegramCallIsGenuine(context)) {
    // The one non-2xx. A caller that cannot present the token is not
    // Telegram, and there is no chat to explain that in.
    return json(403, { error: "Bad secret token." });
  }

  let update: TelegramUpdate;
  try {
    update = (context.request?.json() ?? {}) as TelegramUpdate;
  } catch (e) {
    return json(200, { ok: true });
  }

  if (update.callback_query) return telegramButton(update.callback_query);
  if (update.message) return telegramIncoming(context, update.message);
  // An update this bot does not handle — an edit, a reaction, a join. Taking
  // it off Telegram's queue is the right answer.
  return json(200, { ok: true });
}

/**
 * Whether this really came from Telegram.
 *
 * The only authentication Telegram offers a webhook, and the engine's
 * documentation is explicit that checking it is the script's job: it cannot
 * verify that a message came from the sender it names.
 *
 * Compared whole rather than in constant time. The comparison is against a
 * value an attacker cannot see and must guess in full, over a network path
 * whose jitter dwarfs the difference a short-circuiting compare leaks; and
 * the string comes out of `scriptStorage` on every call, so the timing is not
 * dominated by the compare in any case.
 */
function telegramCallIsGenuine(context: HandlerContext): boolean {
  let expected = "";
  try {
    expected = String(scriptStorage.getItem(TELEGRAM_WEBHOOK_SECRET_KEY) ?? "");
  } catch (e) {
    return false;
  }
  // Unconfigured means closed. An engine with no secret stored must not
  // accept every caller that omits the header.
  if (!expected) return false;

  const headers = context.request?.headers;
  const offered = headers
    ? String(headers["x-telegram-bot-api-secret-token"] ?? "")
    : "";
  return offered !== "" && offered === expected;
}

/** A message from a person. */
function telegramIncoming(
  context: HandlerContext,
  message: TelegramMessage,
): HttpResponse {
  const from = String(message.from?.id ?? "");
  // `from.id` and not `chat.id`: in a group they differ, and keying on the
  // chat would let anybody in that group start the agent of whoever linked
  // it. The identity is the person; the chat is only where to reply.
  const chatId = String(message.chat?.id ?? "");
  const text = String(message.text ?? message.caption ?? "").trim();
  if (!from || !chatId) return json(200, { ok: true });

  // Only Telegram's ids for the files, not the files: this webhook runs as
  // nobody and holds no key to upload them with, so the run downloads them.
  const attached = telegramFiles(message);
  if (attached.refusal) {
    sendTelegram(chatId, attached.refusal);
    return json(200, { ok: true });
  }
  if (!text && attached.files.length === 0) {
    sendTelegram(chatId, "I can read text, photos, PDFs and plain-text files.");
    return json(200, { ok: true });
  }

  let who: SenderState;
  try {
    who = personalTasks.sender({
      channel: TELEGRAM_CHANNEL,
      identity: from,
    });
  } catch (e) {
    sendTelegram(chatId, "Something went wrong looking you up. Try again.");
    return json(200, { ok: true });
  }

  if (!who.granted) {
    return telegramOfferLink(context, from, chatId, who);
  }

  try {
    personalTasks.enqueueFrom({
      channel: TELEGRAM_CHANNEL,
      identity: from,
      handler: "startTelegramRun",
      payload: { text: text, chatId: chatId, files: attached.files },
      maxAttempts: 1,
    });
  } catch (e) {
    // Most likely the per-link budget, which is the one rate limit in the
    // engine whose spender is chosen by whoever sent the message.
    sendTelegram(
      chatId,
      "That is more than I can take at once. Give me a minute.",
    );
    return json(200, { ok: true });
  }

  return json(200, { ok: true });
}

/**
 * Reply with the link that would connect this sender to an account.
 *
 * Sent **into the sender's own chat and nowhere else**, which is the security
 * of the whole scheme: a link that named the sender would be one anybody
 * could build for anybody, and linking somebody else's id first does not
 * merely squat on it — every message they send this bot would become the
 * squatter's turn, with their text in the squatter's storage. Being able to
 * read this chat is the only evidence of ownership the engine can have.
 */
function telegramOfferLink(
  context: HandlerContext,
  from: string,
  chatId: string,
  who: SenderState,
): HttpResponse {
  let invitation: LinkInvitation;
  try {
    invitation = personalTasks.inviteLink({
      channel: TELEGRAM_CHANNEL,
      identity: from,
    });
  } catch (e) {
    sendTelegram(
      chatId,
      "I could not make you a link just now. Try again shortly.",
    );
    return json(200, { ok: true });
  }

  // Three different situations, and saying "authorise me" to all of them
  // would be wrong for two: a person whose grant lapsed has done this before,
  // and one who never linked has not.
  const lead = who.linked
    ? who.expired
      ? "Your permission for me has expired."
      : "I need your permission again."
    : "We have not met yet.";

  sendTelegram(
    chatId,
    `${lead}\n\nOpen this to connect this chat to your account — it works once and lasts ${invitation.expiresInMinutes} minutes:\n${absoluteUrl(context, invitation.linkUrl)}`,
  );
  return json(200, { ok: true });
}

/**
 * Make a link openable from somewhere that is not this site.
 *
 * `inviteLink()` answers with a path — `/auth/delegate?link=...` — which is
 * right for a page that is already on the engine and useless in a chat, where
 * a tap on it goes nowhere. Found by sending one to a test chat and looking
 * at what arrived.
 *
 * The origin comes from the request rather than from a constant, because the
 * engine serves several hosts and the one that should appear in the link is
 * the one Telegram was pointed at. `context.request.url` is the absolute URL
 * the request arrived on, which is the only thing here that knows that.
 */
function absoluteUrl(context: HandlerContext, path: string): string {
  if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) {
    return path;
  }
  const here = String(context.request?.url ?? "");
  const afterScheme = here.indexOf("://");
  if (afterScheme === -1) return path;
  const slash = here.indexOf("/", afterScheme + 3);
  const origin = slash === -1 ? here : here.slice(0, slash);
  return origin + path;
}

/**
 * A button press on a plan.
 *
 * Queued rather than acted on, for the same reason a message is: deciding
 * writes rows, and this execution holds no database access at all. The
 * delegated task that follows runs as whoever linked this sender, so a person
 * can only ever answer their own run — `decide` is scoped by user id, and the
 * callback carries no account of its own to be forged.
 */
function telegramButton(callback: TelegramCallback): HttpResponse {
  const from = String(callback.from?.id ?? "");
  const chatId = String(callback.message?.chat?.id ?? "");
  const callbackId = String(callback.id ?? "");
  const data = String(callback.data ?? "");

  // `approve:<runId>` or `reject:<runId>`.
  const split = data.indexOf(":");
  const decision = split === -1 ? "" : data.slice(0, split);
  const runId = split === -1 ? "" : data.slice(split + 1);

  if (!from || (decision !== "approve" && decision !== "reject") || !runId) {
    answerCallback(callbackId, "I did not understand that button.");
    return json(200, { ok: true });
  }

  try {
    personalTasks.enqueueFrom({
      channel: TELEGRAM_CHANNEL,
      identity: from,
      handler: "decideFromTelegram",
      payload: { runId: runId, decision: decision, chatId: chatId },
      maxAttempts: 1,
    });
    answerCallback(
      callbackId,
      decision === "approve" ? "Approved." : "Rejected.",
    );
  } catch (e) {
    answerCallback(callbackId, "I could not record that. Try again.");
  }
  return json(200, { ok: true });
}

/**
 * Take a message that arrived from Telegram into the chat's conversation.
 *
 * Runs as the person who linked the sender, so it can do what the webhook
 * could not: write the prompt and queue the turn. It is `startRun` with the
 * session replaced by the link and the conversation chosen by `routeMessage`
 * rather than by the page: the chat's latest run while it is recent, a new
 * one after a quiet spell or a `/new`, and words for a run still working are
 * said to it.
 */
function startTelegramRun(context: HandlerContext): void {
  const userId = signedInUser(context);
  if (!userId) {
    quietLog("agent: a telegram run resolved to nobody; abandoning it");
    return;
  }

  const task = context.meta?.task;
  const payload = (task?.payload ?? {}) as {
    text?: string;
    chatId?: string;
    files?: TelegramFile[];
  };
  const command = parseCommand(String(payload.text ?? "").trim());
  const fresh = command.command === "new";
  const text = command.text;
  const chatId = String(payload.chatId ?? "");
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!chatId) return;
  const freshKey = TELEGRAM_FRESH_PREFIX + chatId;
  syncTelegramMenu(chatId);

  if (command.command === "stop") {
    stopTelegramRun(userId, chatId);
    return;
  }

  if (!text && files.length === 0) {
    // `/new` on its own: nothing to answer yet, so the boundary is kept for
    // the next message to start after.
    if (fresh) {
      try {
        personalStorage.setItem(freshKey, String(Date.now()));
        sendTelegram(chatId, "Starting a new conversation.");
      } catch (e) {
        sendTelegram(chatId, `I could not start a new conversation: ${e}`);
      }
    }
    return;
  }

  if (!secretStorage.exists(SECRET_NAME)) {
    sendTelegram(
      chatId,
      "You have not stored an API key yet — runs are billed to your own. Add one on the agent page first.",
    );
    return;
  }

  let route: Route;
  try {
    route = routeMessage(
      latestChatRun(userId, chatId),
      Date.now(),
      Number(personalStorage.getItem(freshKey) ?? 0) || 0,
      fresh,
      files.length > 0,
    );
  } catch (e) {
    sendTelegram(chatId, `I could not find our conversation: ${e}`);
    return;
  }
  if (route.kind === "busy") {
    sendTelegram(
      chatId,
      "I am still working on your last message. Send the file again once I have answered.",
    );
    return;
  }

  // What the model is given; `text` stays what the person sees they sent.
  const said = expandSkillCommand(text);
  let existing: RunRow | null = null;
  try {
    if (route.kind === "say") {
      if (sayToRun(userId, route.runId, said, text)) return;
      // It finished first, so the words are its next prompt instead.
      existing = runRow(userId, route.runId);
    } else if (route.kind === "continue") {
      existing = runRow(userId, route.runId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendTelegram(chatId, `I could not pass that on: ${message}`);
    return;
  }

  // Downloaded and uploaded before anything is stored, as on the page, so a
  // failure leaves no prompt the model would answer without its files.
  let attachments: Attachment[] = [];
  if (files.length > 0) {
    try {
      attachments = uploadAttachments(files.map(downloadTelegramFile));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      quietLog(`agent: could not take a telegram file: ${message}`);
      sendTelegram(chatId, `I could not take the file: ${message}`);
      return;
    }
  }

  const runId = existing ? String(existing.run_id) : newRunId();

  // Everything from here writes, and a delegated task that may not write
  // throws rather than returning — which without this would be silence in
  // the chat, since a failed task has no other way to reach the person. A
  // grant covering reading and not writing is the likeliest cause, and it is
  // worth naming rather than leaving them to guess.
  try {
    // Counted before this prompt is stored, as `startRun` does, so the
    // prompt's turn budget starts at zero.
    const spoken = existing
      ? loadMessages(userId, runId).filter((m) => m.speaker === "assistant")
          .length
      : 0;
    appendMessage(userId, runId, "user", promptBlocks(said, attachments));
    recordActivity(
      userId,
      runId,
      "prompt",
      text || "(" + attachments.length + " attached)",
    );
    if (attachments.length > 0) {
      recordAttachments(userId, runId, attachments);
    }

    const next = personalTasks.enqueue({
      handler: "advanceRun",
      payload: { runId: runId },
      maxAttempts: 1,
    });
    if (existing) {
      reopenRun(userId, existing, next.taskId, spoken);
      return;
    }
    openRun(userId, runId, next.taskId, "chat");
    // Written after opening rather than as part of it, so `openRun` stays the
    // one shape every run starts in and the page path is untouched.
    const row = runRow(userId, runId);
    if (row) {
      writeRow(
        () =>
          database.update("runs", Number(row.id), {
            channel: TELEGRAM_CHANNEL,
            chat_id: chatId,
            updated_ms: Date.now(),
          }),
        "recording where a run came from",
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    quietLog(`agent: could not start a telegram run: ${message}`);
    sendTelegram(chatId, `I could not start: ${message}`);
  }
}

/**
 * Give this chat a `/` menu of `/new` and the skills, when it has changed.
 *
 * Scoped to the chat rather than set for the bot, because the bot's default
 * menu is shown to anybody who opens it and the skill names are this
 * deployment's. Only a private chat: in a group the menu would be every
 * member's. Telegram allows no hyphen in a command, so skills are listed as
 * `parseCommand` reads them back, with underscores. A failure is logged and
 * tried again with the next message, since nothing was stored.
 */
function syncTelegramMenu(chatId: string): void {
  if (chatId.indexOf("-") === 0) return;
  const menu = JSON.stringify(telegramCommands(loadSkills()));
  const key = TELEGRAM_MENU_PREFIX + chatId;
  try {
    if (personalStorage.getItem(key) === menu) return;
    const answer = fetch(TELEGRAM_API + "setMyCommands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: JSON.parse(menu),
        scope: { type: "chat", chat_id: chatId },
      }),
    });
    if (!answer.ok) {
      quietLog(
        `agent: telegram refused the menu: ${String(answer.body).slice(0, 200)}`,
      );
      return;
    }
    personalStorage.setItem(key, menu);
  } catch (e) {
    quietLog(
      `agent: could not set the telegram menu: ${String(e).slice(0, 200)}`,
    );
  }
}

/**
 * `/stop`: stop the chat's run if it is working. Its newest run only, since
 * that is the one a message would be said to. Its state is read and not its
 * age, so a run that went quiet while still marked working is stopped too.
 */
function stopTelegramRun(userId: string, chatId: string): void {
  try {
    const latest = latestChatRun(userId, chatId);
    const stopped = latest ? stopRun(userId, latest).stopped : false;
    if (!latest || !stopped) {
      sendTelegram(chatId, "Nothing is working to stop.");
      return;
    }
    const line = spendLine(promptSpend(userId, String(latest.run_id)), PRICES);
    sendTelegram(chatId, line ? "Stopped. Spent: " + line : "Stopped.");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendTelegram(chatId, `I could not stop it: ${message}`);
  }
}

/** The newest run this chat started, or null. */
function latestChatRun(userId: string, chatId: string): RunRow | null {
  const rows = queryRows(
    "runs",
    { user_id: userId, channel: TELEGRAM_CHANNEL, chat_id: chatId },
    1,
    "id",
    "desc",
  ) as RunRow[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Say something to a run still working, as `/agent/say` does for the page.
 *
 * False when the run finished before any turn took the words, which are then
 * taken back so they can become its next prompt instead. A run that finished
 * after taking them has either answered them or, through `finishRun`, said in
 * the chat that it did not. `said` is what the model is given, `text` what
 * the log shows.
 */
function sayToRun(
  userId: string,
  runId: string,
  said: string,
  text: string,
): boolean {
  const row = database.insert("interjections", {
    user_id: userId,
    run_id: runId,
    body: said,
    created_ms: Date.now(),
  });
  if (runIsLive(userId, runId)) {
    recordActivity(userId, runId, "interject", text);
    return true;
  }
  return !database.delete("interjections", Number(row.id)).deleted;
}

/**
 * Download a file a Telegram message carried, as base64.
 *
 * Two calls, because Telegram answers a file id with a path and serves the
 * bytes from a second address. The bot token is in both URLs' paths, where
 * the engine substitutes it, so it is in no log and no error.
 */
function downloadTelegramFile(file: TelegramFile): {
  name: string;
  contentType: string;
  data: string;
} {
  const located = fetch(
    TELEGRAM_API + "getFile?file_id=" + encodeURIComponent(file.telegramId),
  );
  let path = "";
  try {
    const answer = located.json() as {
      ok?: boolean;
      result?: { file_path?: string };
      description?: string;
    };
    path = String(answer.result?.file_path ?? "");
    if (!path) {
      throw new Error(answer.description ?? "Telegram did not say where it is");
    }
  } catch (e) {
    throw new Error(
      file.name + ": " + (e instanceof Error ? e.message : String(e)),
    );
  }

  const download = fetch(TELEGRAM_FILE_API + path, {
    binary: true,
    timeout: MODEL_TIMEOUT_MS,
  });
  if (!download.ok || !download.bodyBase64) {
    throw new Error(
      `${file.name}: Telegram answered ${download.status} to the download`,
    );
  }
  return {
    name: file.name,
    contentType: file.contentType,
    data: download.bodyBase64,
  };
}

/** Carry out a button press, as the person who pressed it. */
function decideFromTelegram(context: HandlerContext): void {
  const userId = signedInUser(context);
  if (!userId) return;

  const task = context.meta?.task;
  const payload = (task?.payload ?? {}) as {
    runId?: string;
    decision?: string;
    chatId?: string;
  };
  const runId = String(payload.runId ?? "");
  const decision = String(payload.decision ?? "");
  const chatId = String(payload.chatId ?? "");
  if (!runId || (decision !== "approve" && decision !== "reject")) return;

  const outcome = decide(userId, runId, decision, "");
  if (!outcome.ok && chatId) {
    sendTelegram(chatId, outcome.detail);
  }
}

/** Where this run's answers go, if not only to the page. */
function channelFor(
  userId: string,
  runId: string,
): { channel: string; chatId: string } | null {
  const row = runRow(userId, runId);
  if (!row) return null;
  const channel = String(row.channel ?? "");
  const chatId = String(row.chat_id ?? "");
  if (channel !== TELEGRAM_CHANNEL || !chatId) return null;
  return { channel: channel, chatId: chatId };
}

/**
 * Send something to the chat a run came from, if it came from one.
 *
 * A no-op for a run started on the page, which is what keeps every caller
 * from having to know which kind of run it is in.
 */
function notifyChannel(
  userId: string,
  runId: string,
  text: string,
  keyboard?: unknown,
): void {
  const to = channelFor(userId, runId);
  if (!to) return;
  sendTelegram(to.chatId, text, keyboard);
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
  database.insert("messages", {
    user_id: userId,
    run_id: runId,
    speaker: speaker,
    blocks: JSON.stringify(blocks),
    created_ms: Date.now(),
  });
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
    { user_id: userId, run_id: runId },
    HISTORY_QUERY_LIMIT,
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
  detail?: AttachmentDetail[],
): void {
  const at = Date.now();
  database.insert("activities", {
    user_id: userId,
    run_id: runId,
    kind: kind,
    message: message,
    detail: detail ? JSON.stringify(detail) : "",
    created_ms: at,
  });
  routeRegistry.sendStreamMessageFiltered(
    STREAM_PATH,
    detail
      ? { runId: runId, kind: kind, message: message, at: at, detail: detail }
      : { runId: runId, kind: kind, message: message, at: at },
    { userId: userId },
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

const RUN_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

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
