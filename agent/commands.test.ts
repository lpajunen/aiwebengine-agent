/**
 * The commands a person types in place of a prompt.
 */

import { parseCommand, skillPrompt } from "./commands.ts";

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

describe("calling a skill", () => {
  const skills = ["release-notes", "new"];

  test("a skill's name calls it, the words after it the request", () => {
    expect(parseCommand("/release-notes for v2", skills)).toEqual({
      command: "skill",
      skill: "release-notes",
      text: "for v2",
    });
  });

  test("on its own, and in any case", () => {
    expect(parseCommand("/Release-Notes", skills)).toEqual({
      command: "skill",
      skill: "release-notes",
      text: "",
    });
  });

  test("a name that is not a skill is a prompt", () => {
    expect(parseCommand("/release for v2", skills)).toEqual({
      command: null,
      text: "/release for v2",
    });
  });

  test("a built-in command wins over a skill of the same name", () => {
    expect(parseCommand("/new hi", skills).command).toBe("new");
  });

  test("the skill's instructions come before the request", () => {
    const text = skillPrompt("release-notes", "\nList the changes.\n", "v2");
    expect(
      text.indexOf('<skill name="release-notes">\nList the changes.\n</skill>'),
    ).toBeGreaterThan(0);
    expect(text.slice(-2)).toBe("v2");
  });

  test("a skill called on its own still asks for something", () => {
    expect(skillPrompt("release-notes", "List.", "")).toContain(
      "the skill is the request",
    );
  });
});
