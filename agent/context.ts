/**
 * What a turn sends the model, kept so a person can read it afterwards.
 *
 * The system prompt is built from parts, and which parts a turn gets depends
 * on the run's mode and on what the person granted. Building it as labelled
 * parts lets the inspect page say why each one is there, and joining the same
 * parts is what is sent, so the page cannot describe a prompt the model never
 * saw.
 *
 * Apart from `main.ts` for the reason `protocol.ts` gives — a root script
 * cannot `export`.
 */

import { shortHash } from "./skills.ts";

/** One piece of the system prompt. */
export interface PromptPart {
  /** Stable, for the page to key on. */
  key: string;
  /** What this part is, for a person. */
  label: string;
  /** Why this turn has it. */
  why: string;
  /** What comes between it and the part before. */
  sep: string;
  text: string;
}

/** The system prompt the parts make: exactly what the model is sent. */
export function joinParts(parts: readonly PromptPart[]): string {
  let text = "";
  for (const part of parts) text += part.sep + part.text;
  return text;
}

/**
 * A mark for one version of everything before the conversation: the system
 * prompt, the tools and the settings. Turns that sent the same thing share a
 * mark, so a run stores each version once. The length rides beside the hash
 * so a collision needs two versions of the same size.
 */
export function requestMark(
  parts: readonly PromptPart[],
  tools: readonly unknown[],
  settings: Record<string, unknown>,
): string {
  const text = JSON.stringify([parts, tools, settings]);
  return shortHash(text) + "-" + text.length.toString(36);
}

/** A stored version of what a turn sent, as the inspect page reads it. */
export interface SentPrompt {
  mark: string;
  parts: PromptPart[];
  tools: unknown[];
  settings: Record<string, unknown>;
  at: number;
}

interface SentPromptRow {
  mark?: unknown;
  system_parts?: unknown;
  tools?: unknown;
  settings?: unknown;
  created_ms?: unknown;
}

/** A stored row read back, or null when its JSON does not parse. */
export function sentPromptOf(row: SentPromptRow): SentPrompt | null {
  try {
    const parts = JSON.parse(String(row.system_parts ?? "[]"));
    const tools = JSON.parse(String(row.tools ?? "[]"));
    const settings = JSON.parse(String(row.settings ?? "{}"));
    if (!Array.isArray(parts) || !Array.isArray(tools)) return null;
    return {
      mark: String(row.mark ?? ""),
      parts: parts as PromptPart[],
      tools: tools,
      settings:
        settings && typeof settings === "object"
          ? (settings as Record<string, unknown>)
          : {},
      at: Number(row.created_ms ?? 0),
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Instructions: the deployment's and the person's own
// ---------------------------------------------------------------------------

/** The deployment's instructions: a private file beside `main.ts`. */
export const SHARED_INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

/** Every turn pays for these, so both are bounded. */
export const MAX_OWN_INSTRUCTIONS_CHARS = 4000;
export const MAX_SHARED_INSTRUCTIONS_CHARS = 8000;

/** Instructions as stored and sent: one kind of newline, no outer space. */
export function tidyInstructions(text: unknown, max: number): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

/** Why a person's instructions cannot be saved, or null when they can. */
export function ownInstructionsProblem(text: string): string | null {
  if (text.length <= MAX_OWN_INSTRUCTIONS_CHARS) return null;
  return (
    "Your instructions are " +
    text.length +
    " characters; the most is " +
    MAX_OWN_INSTRUCTIONS_CHARS +
    ". Every turn sends them, so keep them to what applies every time."
  );
}

/**
 * The instruction parts of a system prompt, after everything the agent itself
 * says. The deployment's come first and win over the person's; the person's
 * yield to everything above them, so they can shape style and preferences but
 * not talk a run out of asking before it changes something. A run that builds
 * a script follows a fixed procedure and gets the deployment's only.
 */
export function instructionParts(
  shared: string,
  own: string,
  kind: string,
): PromptPart[] {
  const parts: PromptPart[] = [];
  if (shared) {
    parts.push({
      key: "deployment",
      label: "This deployment's instructions",
      why:
        "Written by whoever runs this agent, in " +
        SHARED_INSTRUCTIONS_FILE +
        ".",
      sep: "\n\n",
      text:
        "Instructions from whoever runs this agent. Follow them; where the " +
        "person's own instructions disagree with them, these win.\n\n" +
        "<deployment_instructions>\n" +
        shared +
        "\n</deployment_instructions>",
    });
  }
  if (own && kind !== "author") {
    parts.push({
      key: "person",
      label: "Your instructions",
      why: "You wrote these. They apply to every conversation, from the prompt after you save them.",
      sep: "\n\n",
      text:
        "Instructions the person wrote for every conversation with you. " +
        "Follow them, except where they conflict with anything above.\n\n" +
        "<person_instructions>\n" +
        own +
        "\n</person_instructions>",
    });
  }
  return parts;
}
