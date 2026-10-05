// The authoring half of the agent: what a run that builds a script is given,
// and how it is judged.
//
// Kept apart from `main.ts` for the usual reason in this folder — a root
// script cannot `export`, and a test module reaches its subject by importing
// it — and because nothing here touches the database or the engine. The
// harness calls these with what the engine answered and does the I/O itself.

/** What a run is for: a conversation, or building a script. */
export type RunKind = "chat" | "author";

/**
 * Budgets, per kind of run.
 *
 * A chat answer is short and a turn that writes several files is not, so the
 * two cannot share a ceiling: 8,000 output tokens on every chat turn would
 * only buy slower answers, and 1,024 on an authoring turn cuts a file off in
 * the middle.
 */
export const CHAT_MAX_TOKENS = 1024;
export const CHAT_MAX_STEPS = 12;
export const AUTHOR_MAX_TOKENS = 8000;
export const AUTHOR_MAX_STEPS = 25;

export function maxTokensFor(kind: RunKind): number {
  return kind === "author" ? AUTHOR_MAX_TOKENS : CHAT_MAX_TOKENS;
}

export function maxStepsFor(kind: RunKind): number {
  return kind === "author" ? AUTHOR_MAX_STEPS : CHAT_MAX_STEPS;
}

/** The largest step budget any kind has, for bounding a read of a run's rows. */
export const MOST_STEPS = AUTHOR_MAX_STEPS;

export function runKindOf(value: unknown): RunKind {
  return value === "author" ? "author" : "chat";
}

/** The shapes of script a run may build, one starter template each. */
export const SHAPES = ["site", "tool", "agent"];

export function isShape(value: string): boolean {
  return SHAPES.indexOf(value) !== -1;
}

/** Where a shape's starter files live in the engine, once pulled. */
export function templateScriptFor(shape: string): string {
  return "template-" + shape;
}

/** What the first write of every script is: it registers nothing. */
export const STUB_SOURCE =
  "// Placeholder while the script is being built; it serves nothing.\n" +
  "function init() {}\n";

/**
 * Why a script cannot be opened for editing, or `null` when it can.
 *
 * Ownership is the whole question. The engine would refuse a write by an
 * account that does not own the script, but a run holding `administer` would
 * not be refused, and "the scripts the person owns" is what was promised.
 */
export function notOpenable(
  script: string,
  owners: unknown,
  userId: string,
): string | null {
  const list = Array.isArray(owners) ? owners : [];
  if (userId && list.indexOf(userId) !== -1) return null;
  return `"${script}" is not a script this person owns, so it cannot be changed here.`;
}

/**
 * Why a name cannot be used for a new script, or `null` when it can.
 *
 * A slug, as the engine requires, and kept clear of the names that are
 * somebody else's: a template, and the agent itself.
 */
export function scriptNameProblem(name: string): string | null {
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) || name.length > 40) {
    return (
      `"${name}" is not a usable script name. Use lower case letters, digits ` +
      "and hyphens, starting with a letter, 2 to 40 characters — for example " +
      '"garden-club".'
    );
  }
  if (name.indexOf("template-") === 0 || name === "agent") {
    return `"${name}" is reserved. Choose another name.`;
  }
  return null;
}

/** Starter files that exist to be replaced, whatever shape the script is. */
export const PLACEHOLDER_PATHS = ["lib/example.ts", "lib/example.test.ts"];

/** The line the agent starter's instructions file opens with. */
export const INSTRUCTIONS_PLACEHOLDER = "Replace this with the instructions";

/**
 * Which of a script's files are still the starter's placeholders.
 *
 * A small model given a file called `lib/example.ts` will fill it in rather
 * than create the `lib/length.ts` the request names, so the answer is for the
 * harness to check, not for the model to remember.
 */
export function leftoverPlaceholders(paths: string[]): string[] {
  return paths.filter((path) => PLACEHOLDER_PATHS.indexOf(path) !== -1);
}

// ============================================================================
// What the engine said, in the size a small model can use
// ============================================================================

/** Cut at a length, saying so. */
export function clip(text: string, max: number): string {
  const flat = String(text);
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}

interface Diagnostic {
  severity?: string;
  code?: string;
  message?: string;
  file?: string;
  line?: number;
}

const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_CHARS = 500;

/**
 * A `check_script` report as the model should read it: the verdict first,
 * then each error with its file and line, then what the script registers.
 *
 * The engine's report is a large object whose useful part is a handful of
 * sentences; handing a small model the whole of it spends the turn on parsing.
 */
export function summariseCheck(report: unknown): string {
  const r = (report ?? {}) as {
    ok?: boolean;
    diagnostics?: Diagnostic[];
    registrations?: { kind?: string; name?: string; method?: string }[];
    error?: unknown;
    message?: unknown;
  };
  if (r.error !== undefined && r.diagnostics === undefined) {
    return "check could not run: " + clip(String(r.error), 300);
  }
  const diagnostics = Array.isArray(r.diagnostics) ? r.diagnostics : [];
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity !== "error");
  const lines: string[] = [];
  lines.push(
    r.ok === true
      ? "check: passed" +
          (warnings.length ? ` (${warnings.length} warning(s))` : "")
      : `check: FAILED — ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  const shown = errors.concat(warnings).slice(0, MAX_DIAGNOSTICS);
  for (const d of shown) {
    const where = d.file
      ? ` (${d.file}${d.line !== undefined ? ":" + d.line : ""})`
      : "";
    lines.push(
      `- ${d.severity ?? "info"} ${d.code ?? ""}${where}: ` +
        clip(String(d.message ?? ""), MAX_DIAGNOSTIC_CHARS),
    );
  }
  if (diagnostics.length > shown.length) {
    lines.push(`- …and ${diagnostics.length - shown.length} more`);
  }
  const registrations = Array.isArray(r.registrations) ? r.registrations : [];
  if (registrations.length > 0) {
    lines.push(
      "registers: " +
        registrations
          .slice(0, 12)
          .map((x) => [x.kind, x.method, x.name].filter(Boolean).join(" "))
          .join("; "),
    );
  }
  return lines.join("\n");
}

interface TestCase {
  name?: string;
  file?: string;
  status?: string;
  error?: string;
}

/** A `run_tests` report: the count, and the first failures in full. */
export function summariseTests(report: unknown): string {
  const r = (report ?? {}) as {
    success?: boolean;
    total?: number;
    passed?: number;
    cases?: TestCase[];
    error?: unknown;
    timedOut?: boolean;
  };
  if (r.error !== undefined && r.cases === undefined) {
    return "tests could not run: " + clip(String(r.error), 300);
  }
  const total = Number(r.total ?? 0);
  const passed = Number(r.passed ?? 0);
  if (total === 0) {
    return "tests: none found. Write a *.test.ts file; a script with no tests does not pass.";
  }
  const lines = [
    r.success === true
      ? `tests: all ${total} passed`
      : `tests: FAILED — ${passed} of ${total} passed` +
        (r.timedOut ? " (timed out)" : ""),
  ];
  const failed = (Array.isArray(r.cases) ? r.cases : []).filter(
    (c) => c.status !== "passed",
  );
  for (const c of failed.slice(0, 5)) {
    lines.push(
      `- ${c.name ?? "?"}${c.file ? " (" + c.file + ")" : ""}: ` +
        clip(String(c.error ?? ""), 500),
    );
  }
  if (failed.length > 5) lines.push(`- …and ${failed.length - 5} more`);
  return lines.join("\n");
}

/** Whether a `run_tests` report is a pass: something ran and all of it passed. */
export function testsPassed(report: unknown): boolean {
  const r = (report ?? {}) as { success?: boolean; total?: number };
  return r.success === true && Number(r.total ?? 0) > 0;
}

// ============================================================================
// What a small model sends
// ============================================================================

/**
 * Parse JSON a model wrote, forgiving the usual slip: a raw newline or tab
 * inside a string, which JSON forbids and a model writing code in a string
 * does all the time. Anything else is left to fail.
 */
export function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (first) {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          out += c;
        } else if (c === "\\") {
          escaped = true;
          out += c;
        } else if (c === '"') {
          inString = false;
          out += c;
        } else if (c === "\n") {
          out += "\\n";
        } else if (c === "\r") {
          out += "\\r";
        } else if (c === "\t") {
          out += "\\t";
        } else {
          out += c;
        }
      } else {
        if (c === '"') inString = true;
        out += c;
      }
    }
    return JSON.parse(out);
  }
}

/**
 * Undo a file that was written with its newlines escaped twice.
 *
 * A model putting code inside a JSON string sometimes escapes the escapes, so
 * the file arrives as one line holding literal backslash-n sequences, which
 * does not compile. Source of any length that has no real newline and several
 * of those sequences is that, and nothing legitimate: a real one-liner holds
 * at most a string with one or two. Anything else is returned untouched.
 */
export function repairEscapedSource(text: string): string {
  if (text.indexOf("\n") !== -1) return text;
  const escapes = text.split("\\n").length - 1;
  if (escapes < 3) return text;
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
}

/** The files of a `write_files` call, read leniently, or why they cannot be. */
export function readFilesArgument(raw: unknown): {
  files: { name: string; text: string }[];
  problem: string | null;
} {
  let value = raw;
  // A model that has been asked for an array of objects will sometimes send
  // the JSON of one, as a string.
  if (typeof value === "string") {
    const sent = value;
    try {
      value = parseLooseJson(sent);
    } catch (e) {
      return {
        files: [],
        problem:
          "'files' must be an array of {path, text} objects, not a string, and " +
          "the string you sent is not valid JSON (" +
          (e instanceof Error ? e.message : String(e)) +
          "). It began: " +
          clip(sent, 80) +
          " — send an array, or write one file at a time with write_file.",
      };
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // One file sent on its own.
    value = [value];
  }
  if (!Array.isArray(value) || value.length === 0) {
    return {
      files: [],
      problem:
        "'files' must be a non-empty array of {path, text} objects, e.g. " +
        '[{"path": "lib/dates.ts", "text": "export function f() {}"}].',
    };
  }
  const files: { name: string; text: string }[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = (value[i] ?? {}) as Record<string, unknown>;
    const path = String(item.path ?? item.name ?? item.file ?? "").trim();
    const text = item.text ?? item.content;
    if (!path) {
      return { files: [], problem: `files[${i}] has no 'path'.` };
    }
    if (typeof text !== "string") {
      return {
        files: [],
        problem: `files[${i}] ("${path}") has no 'text': send the file's whole contents as a string.`,
      };
    }
    files.push({ name: path, text: repairEscapedSource(text) });
  }
  return { files: files, problem: null };
}

/** The `remove` argument: paths, as an array or as one string. */
export function readRemoveArgument(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw.map((p) => String(p).trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((p) => String(p).trim()).filter(Boolean);
      }
    } catch (e) {
      // Not JSON: a single path.
    }
    return [raw.trim()];
  }
  return [];
}

// ============================================================================
// Editing from memory
// ============================================================================

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text of `file` that `needle` means, when it differs from `needle` only
 * in whitespace and there is exactly one such place.
 *
 * A model edits a file it wrote some turns ago from memory, and gets the
 * indentation or a line break wrong; the words are right. Returns `null` when
 * there is no such place or more than one, since guessing which is how an edit
 * lands in the wrong place.
 */
export function findLoose(file: string, needle: string): string | null {
  const words = needle.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  const found = file.match(
    new RegExp(words.map(escapeRegExp).join("\\s+"), "g"),
  );
  return found !== null && found.length === 1 ? found[0] : null;
}

/**
 * An edit rewritten against the file's own text, or `null` when it cannot be.
 *
 * The old string becomes what the file really holds; the new one loses the
 * whitespace at its ends that the old one lost, so it does not indent twice.
 */
export function looseEdit(
  file: string,
  oldString: string,
  newString: string,
): { oldString: string; newString: string } | null {
  const exact = findLoose(file, oldString);
  if (exact === null || exact === oldString) return null;
  let replacement = newString;
  if (/^\s/.test(oldString)) replacement = replacement.replace(/^\s+/, "");
  if (/\s$/.test(oldString)) replacement = replacement.replace(/\s+$/, "");
  return { oldString: exact, newString: replacement };
}

/**
 * The lines of `file` nearest to what `needle` was meant to find, numbered, or
 * an empty string when nothing is near.
 *
 * Nearest is by the words of the needle's first line: it is the part most
 * likely to be right, and showing the real text beside it is usually all the
 * model needs to copy it correctly.
 */
export function nearestRegion(
  file: string,
  needle: string,
  around: number = 3,
): string {
  const first = needle.split("\n").find((line) => line.trim().length > 0) ?? "";
  const words = first
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((word) => word.length >= 3);
  if (words.length === 0) return "";
  const lines = file.split("\n");
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;
    for (const word of words) if (lower.indexOf(word) !== -1) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return "";
  const from = Math.max(0, best - around);
  const to = Math.min(lines.length, best + around + 1);
  const shown: string[] = [];
  for (let i = from; i < to; i++) shown.push(`${i + 1}: ${lines[i]}`);
  return shown.join("\n");
}

// ============================================================================
// Not looping
// ============================================================================

/** How many times the same failure may come back before the run stops. */
export const ESCALATE_AT = 3;

/**
 * What a failing verdict is, boiled down so the same failure compares equal.
 *
 * The codes and the start of each message, not the whole text: a line number
 * moves when the author edits around the fault, and the fault is still the
 * same fault. `null` means the verdict passed.
 */
export function failureSignature(kind: string, report: unknown): string | null {
  if (kind === "check") {
    const r = (report ?? {}) as { ok?: boolean; diagnostics?: Diagnostic[] };
    if (r.ok === true) return null;
    const errors = (Array.isArray(r.diagnostics) ? r.diagnostics : []).filter(
      (d) => d.severity === "error",
    );
    if (errors.length === 0) return "check:unknown";
    return (
      "check:" +
      errors
        .map(
          (d) =>
            `${d.code ?? ""}|${(d.file ?? "").replace(/:\d+.*$/, "")}|` +
            String(d.message ?? "")
              .replace(/\d+/g, "#")
              .slice(0, 80),
        )
        .sort()
        .join(";")
    );
  }
  if (testsPassed(report)) return null;
  const r = (report ?? {}) as { cases?: TestCase[] };
  const failed = (Array.isArray(r.cases) ? r.cases : []).filter(
    (c) => c.status !== "passed",
  );
  if (failed.length === 0) return "tests:none-or-error";
  return (
    "tests:" +
    failed
      .map((c) => `${c.name ?? ""}|${String(c.error ?? "").slice(0, 60)}`)
      .sort()
      .join(";")
  );
}

/** Failures in a row: the signature, and how many times it has come back. */
export interface FailureCount {
  sig: string;
  count: number;
}

/**
 * Fold one verdict into the running count. A pass clears it; the same failure
 * again adds one; a different failure starts over, since that is progress.
 */
export function nextFailureCount(
  previous: FailureCount | null,
  signature: string | null,
): FailureCount | null {
  if (signature === null) return null;
  if (previous !== null && previous.sig === signature) {
    return { sig: signature, count: previous.count + 1 };
  }
  return { sig: signature, count: 1 };
}

export function shouldEscalate(count: FailureCount | null): boolean {
  return count !== null && count.count >= ESCALATE_AT;
}

/**
 * The note a person carries to a developer when the run gave up.
 *
 * Written so a developer in Claude Code can start from it without asking
 * anything: what was wanted, where the script is, what it said last, and what
 * was already tried.
 */
export function handoffNote(note: {
  request: string;
  script: string;
  revision: string;
  lastVerdict: string;
  tried: string[];
  reason: string;
}): string {
  const lines = [
    "## Handoff: I could not finish this script",
    "",
    note.reason,
    "",
    "**Request**",
    "",
    clip(note.request, 1500),
    "",
    `**Script** \`${note.script || "(not created)"}\`${
      note.revision ? ", revision " + note.revision : ""
    }`,
    "",
    "**Last verdict**",
    "",
    "```text",
    clip(note.lastVerdict || "(none)", 1500),
    "```",
    "",
    "**What was tried**",
    "",
  ];
  if (note.tried.length === 0) lines.push("- (nothing recorded)");
  for (const step of note.tried) lines.push("- " + clip(step, 200));
  lines.push(
    "",
    "To continue: open this script in Claude Code with the engine's tools, " +
      "read the files, and fix what the last verdict names. The script is " +
      "still the draft; nothing new is being served.",
  );
  return lines.join("\n");
}

// ============================================================================
// The tools an authoring run is given
// ============================================================================

interface AuthorTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const SCRIPT_PROPERTY = {
  type: "string",
  description: "The script's name, as create_script or open_script gave it",
};

/**
 * The tools of a run that builds a script — in place of discovering the
 * engine's tools and calling them by name, which is a lookup a small model
 * spends turns on and gets wrong.
 *
 * Each one is bound to the scripts this run created: the harness refuses
 * anything else, so there is no argument that can point one at somebody's
 * existing script.
 */
export const AUTHOR_TOOLS: AuthorTool[] = [
  {
    name: "create_script",
    description:
      "Start a new script from the starter template for its shape (site, tool or agent). " +
      "Answers with the starter's files, the primer and the guide for that shape: read them before writing. " +
      "Call this first, once.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Lower case letters, digits and hyphens, e.g. "garden-club"',
        },
        shape: {
          type: "string",
          enum: SHAPES,
          description:
            "site: pages and routes. tool: an MCP tool. agent: calls a model.",
        },
      },
      required: ["name", "shape"],
    },
  },
  {
    name: "open_script",
    description:
      "Work on a script the person already owns, instead of creating one. Answers with its files. " +
      "What is served does not change until request_deploy is approved. " +
      "Call this first, once, in place of create_script.",
    input_schema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "The name of an existing script the person owns",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "write_files",
    description:
      "Write several files of the script at once (plain text in 'text'). Answers with whether init() ran and the engine's check: " +
      "fix every error it lists before doing anything else.",
    input_schema: {
      type: "object",
      properties: {
        script: SCRIPT_PROPERTY,
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "e.g. main.ts, lib/util.ts, public/index.html",
              },
              text: { type: "string" },
            },
            required: ["path", "text"],
          },
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Paths to delete",
        },
      },
      required: ["script", "files"],
    },
  },
  {
    name: "write_file",
    description:
      "Write one whole file of the script. Simpler than write_files and the better choice for a long file. " +
      "It does not check: call check_script once every file is written.",
    input_schema: {
      type: "object",
      properties: {
        script: SCRIPT_PROPERTY,
        path: {
          type: "string",
          description: "e.g. main.ts, lib/util.ts, skills/faq.md",
        },
        text: { type: "string", description: "The file's whole contents" },
      },
      required: ["script", "path", "text"],
    },
  },
  {
    name: "edit_file",
    description:
      "Change part of one file by replacing text. old_string must be copied from the file exactly and appear once; read_file first if you are not sure what it says now, and use write_file to replace a whole file. Answers with the engine's check.",
    input_schema: {
      type: "object",
      properties: {
        script: SCRIPT_PROPERTY,
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["script", "path", "old_string", "new_string"],
    },
  },
  {
    name: "read_file",
    description:
      "Read one file of the script, or list its files when 'path' is omitted.",
    input_schema: {
      type: "object",
      properties: {
        script: SCRIPT_PROPERTY,
        path: { type: "string" },
      },
      required: ["script"],
    },
  },
  {
    name: "check_script",
    description:
      "Check the script as written: imports, init(), handlers that do not exist, refused registrations.",
    input_schema: {
      type: "object",
      properties: { script: SCRIPT_PROPERTY },
      required: ["script"],
    },
  },
  {
    name: "run_tests",
    description:
      "Run the script's *.test.ts files against what is written now. Behaviour is checked here, by calling functions directly; routes are not served until the script is deployed.",
    input_schema: {
      type: "object",
      properties: {
        script: SCRIPT_PROPERTY,
        filter: { type: "string", description: "Only cases containing this" },
      },
      required: ["script"],
    },
  },
  {
    name: "read_logs",
    description: "Read the script's recent log lines, newest last.",
    input_schema: {
      type: "object",
      properties: {
        script: SCRIPT_PROPERTY,
        level: { type: "string", description: "e.g. ERROR" },
      },
      required: ["script"],
    },
  },
  {
    name: "request_deploy",
    description:
      "Ask the person to approve serving the script. Runs the check and the tests first and refuses if either fails. " +
      "Nothing is served until they approve. Call it once, when the work is done.",
    input_schema: {
      type: "object",
      properties: {
        script: SCRIPT_PROPERTY,
        summary: {
          type: "string",
          description: "What the script does, in a sentence the person reads",
        },
      },
      required: ["script", "summary"],
    },
  },
];

/** Names of the authoring tools, for deciding whether a call is one. */
export function isAuthorTool(name: string): boolean {
  return AUTHOR_TOOLS.some((tool) => tool.name === name);
}

/**
 * What an authoring run is told, once, at the top.
 *
 * Short on purpose and numbered as the loop runs: a small model follows an
 * ordered list it can find its place in, and loses a paragraph.
 */
export const AUTHOR_PROMPT = [
  "You build a small script for the person who asked, using only your tools.",
  "1. To build something new, call create_script with a name and a shape (site, tool or agent). It copies a starter and shows you the primer and the guide for that shape. Read both before you write. To change a script the person already has, call open_script with its name instead, then read the files you will change.",
  "2. Change the starter with write_file (one whole file), write_files (several) or edit_file. Write the code and a *.test.ts file for the logic.",
  "3. Every write answers with the engine's check. Fix every error it lists before anything else: it names the file and the fix. check_script and run_tests check again.",
  "4. When the check and the tests pass, call request_deploy once. Nothing is served until the person approves it.",
  "5. Then call write_response to say what you built and where.",
  "Use exactly the file names, function names, routes and tool names the request gives. The starter's names (lib/example.ts and so on) are placeholders: put your code in the files the request names and delete the placeholders.",
  "Test every route or tool handler by calling it from a *.test.ts with a request context (makeContext in lib/testing.ts) and asserting on its status and body: a handler no test calls is where the wrong status gets through.",
  "A turn that says what you are about to do without calling a tool does nothing: call the tool in the same turn.",
  "Never say you created, wrote or deployed something that a tool has not confirmed.",
  "If the same failure comes back three times, the run stops and writes a note for a developer. That is the intended outcome, not a failure to hide.",
].join("\n");

/** Said to a turn that spoke and called nothing, in an authoring run. */
export const NUDGE =
  "You have not finished and nothing happened that turn. Call the next tool now (create_script, open_script, write_file, check_script, run_tests or request_deploy); do not describe it first.";

/** How many such turns a run may have before it stops. */
export const MAX_NUDGES = 3;
