/**
 * The commands a person types in place of a prompt.
 */

import { parseCommand, skillPrompt, telegramCommands } from "./commands.ts";

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

describe("the Telegram menu", () => {
  test("/new first, then each skill as Telegram spells it", () => {
    expect(
      telegramCommands([
        { name: "release-notes", description: "Write release notes." },
      ]),
    ).toEqual([
      { command: "new", description: "Start a new conversation" },
      { command: "release_notes", description: "Write release notes." },
    ]);
  });

  test("the name Telegram sends back calls the skill", () => {
    expect(parseCommand("/release_notes v2", ["release-notes"])).toEqual({
      command: "skill",
      skill: "release-notes",
      text: "v2",
    });
  });

  test("a name too long for Telegram and a shadowed one are left out", () => {
    const long = "a".repeat(33);
    const menu = telegramCommands([
      { name: long, description: "x" },
      { name: "new", description: "x" },
    ]);
    expect(menu.map((c) => c.command)).toEqual(["new"]);
  });

  test("a description is never empty and never too long", () => {
    const [, skill] = telegramCommands([{ name: "a", description: "" }]);
    expect(skill.description).toBe("a");
    const [, cut] = telegramCommands([
      { name: "b", description: "d".repeat(300) },
    ]);
    expect(cut.description.length).toBe(256);
  });

  test("at most a hundred entries", () => {
    const many = [];
    for (let i = 0; i < 150; i++)
      many.push({ name: "s" + i, description: "x" });
    expect(telegramCommands(many).length).toBe(100);
  });
});
