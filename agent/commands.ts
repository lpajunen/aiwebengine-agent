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

/** `new`: start a new conversation, the words after it its first prompt. */
export type Command = "new";

export interface ParsedCommand {
  /** The command used, or null when the message is a prompt. */
  command: Command | null;
  /** The message without the command: the prompt, possibly empty. */
  text: string;
}

const COMMANDS: Record<string, Command> = {
  new: "new",
  // What Telegram sends when someone first opens the bot.
  start: "new",
};

/** The command a message begins with, and the words after it. */
export function parseCommand(text: string): ParsedCommand {
  // `@name` is how a command addresses one bot in a Telegram group.
  const match = /^\/([a-z]+)(@\w+)?(?:\s+|$)/i.exec(text);
  const name = match ? match[1].toLowerCase() : "";
  // Own keys only: `/constructor` is a prompt, not `Object.prototype`'s.
  if (!match || !Object.prototype.hasOwnProperty.call(COMMANDS, name)) {
    return { command: null, text: text };
  }
  return { command: COMMANDS[name], text: text.slice(match[0].length).trim() };
}
