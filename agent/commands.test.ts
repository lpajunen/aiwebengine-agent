/**
 * The commands a person types in place of a prompt.
 */

import { parseCommand } from "./commands.ts";

describe("parsing a command", () => {
  test("plain text is not a command", () => {
    expect(parseCommand("hello")).toEqual({ command: null, text: "hello" });
  });

  test("/new alone starts fresh with nothing to say", () => {
    expect(parseCommand("/new")).toEqual({ command: "new", text: "" });
  });

  test("the words after /new are the first prompt", () => {
    expect(parseCommand("/new  what is this?")).toEqual({
      command: "new",
      text: "what is this?",
    });
  });

  test("/start, a bot name and any case count", () => {
    expect(parseCommand("/start").command).toBe("new");
    expect(parseCommand("/NEW@agent_bot hi")).toEqual({
      command: "new",
      text: "hi",
    });
  });

  test("a longer word that begins with new is not the command", () => {
    expect(parseCommand("/newsletter").command).toBe(null);
  });

  test("an unknown command is a prompt, word for word", () => {
    expect(parseCommand("/etc/hosts has what?")).toEqual({
      command: null,
      text: "/etc/hosts has what?",
    });
    expect(parseCommand("/constructor").command).toBe(null);
  });
});
