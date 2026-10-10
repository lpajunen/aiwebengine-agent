/**
 * Commands a person types in place of a prompt.
 *
 * One parser for every channel, so a command means the same on the page and
 * in a Telegram chat. A message that does not begin with a known command is a
 * prompt, word for word: an unknown `/word` is for the model, not refused.
 *
 * Apart from `main.ts` for the reason `protocol.ts` gives — a root script
 * cannot `export`.
 */

export type ParsedCommand =
  /** A prompt, word for word. */
  | { command: null; text: string }
  /** Start a new conversation, the words after it its first prompt. */
  | { command: "new"; text: string }
  /** Follow this skill, the words after it what to follow it for. */
  | { command: "skill"; skill: string; text: string };

/** Built in, so a skill of the same name cannot be called by it. */
const BUILT_IN: Record<string, "new"> = {
  new: "new",
  // What Telegram sends when someone first opens the bot.
  start: "new",
};

/**
 * The command a message begins with, and the words after it. `skills` are the
 * names a `/<name>` may call; anything else is left as a prompt.
 */
export function parseCommand(
  text: string,
  skills: readonly string[] = [],
): ParsedCommand {
  // `@name` is how a command addresses one bot in a Telegram group.
  const match = /^\/([a-z0-9][a-z0-9-]*)(@\w+)?(?:\s+|$)/i.exec(text);
  if (!match) return { command: null, text: text };
  const name = match[1].toLowerCase();
  const rest = text.slice(match[0].length).trim();
  // Own keys only: `/constructor` is a prompt, not `Object.prototype`'s.
  if (Object.prototype.hasOwnProperty.call(BUILT_IN, name)) {
    return { command: BUILT_IN[name], text: rest };
  }
  for (const skill of skills) {
    if (skill.toLowerCase() === name) {
      return { command: "skill", skill: skill, text: rest };
    }
  }
  return { command: null, text: text };
}

/**
 * What the model is given for `/<skill> words`: the skill's instructions in
 * the message itself, so following them does not first cost a `read_skill`
 * turn, and a continued conversation still has them.
 */
export function skillPrompt(skill: string, body: string, text: string): string {
  return (
    `The person called the skill "${skill}". Follow its instructions for ` +
    `this request.\n\n<skill name="${skill}">\n${body.trim()}\n</skill>\n\n` +
    (text || "(Nothing more was said: the skill is the request.)")
  );
}
