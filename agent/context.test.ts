/**
 * What a turn sends the model, as parts and as the record of it.
 */

import {
  MAX_OWN_INSTRUCTIONS_CHARS,
  instructionParts,
  joinParts,
  ownInstructionsProblem,
  requestMark,
  sentPromptOf,
  tidyInstructions,
} from "./context.ts";

const part = (key: string, sep: string, text: string) => ({
  key: key,
  label: key,
  why: "",
  sep: sep,
  text: text,
});

describe("the system prompt in parts", () => {
  test("joined, the parts are the prompt, separators and all", () => {
    expect(
      joinParts([
        part("base", "", "Be helpful."),
        part("mode", " ", "Plan first."),
        part("skills", "\n\n", "- a: b"),
      ]),
    ).toBe("Be helpful. Plan first.\n\n- a: b");
  });

  test("no parts is an empty prompt", () => {
    expect(joinParts([])).toBe("");
  });
});

describe("the mark of what a turn sent", () => {
  const parts = [part("base", "", "Be helpful.")];

  test("the same request has the same mark", () => {
    expect(requestMark(parts, [{ name: "t" }], { model: "m" })).toBe(
      requestMark(parts, [{ name: "t" }], { model: "m" }),
    );
  });

  test("any change moves it", () => {
    const mark = requestMark(parts, [], { model: "m" });
    expect(requestMark(parts, [], { model: "n" })).not.toBe(mark);
    expect(requestMark(parts, [{ name: "t" }], { model: "m" })).not.toBe(mark);
    expect(
      requestMark([part("base", "", "Be brief.")], [], { model: "m" }),
    ).not.toBe(mark);
  });
});

describe("a stored version read back", () => {
  test("its JSON columns parsed", () => {
    expect(
      sentPromptOf({
        mark: "x",
        system_parts: JSON.stringify([part("base", "", "Hi.")]),
        tools: "[]",
        settings: '{"model":"m"}',
        created_ms: 5,
      }),
    ).toEqual({
      mark: "x",
      parts: [part("base", "", "Hi.")],
      tools: [],
      settings: { model: "m" },
      at: 5,
    });
  });

  test("a row that does not parse is left out", () => {
    expect(sentPromptOf({ mark: "x", system_parts: "{" })).toBe(null);
    expect(sentPromptOf({ mark: "x", system_parts: "{}" })).toBe(null);
  });
});

describe("instructions", () => {
  test("tidied: one kind of newline, trimmed, bounded", () => {
    expect(tidyInstructions("  a\r\nb\rc  ", 100)).toBe("a\nb\nc");
    expect(tidyInstructions(undefined, 100)).toBe("");
    expect(tidyInstructions("abcdef", 3)).toBe("abc");
  });

  test("a person's are refused past the limit, saying the limit", () => {
    expect(ownInstructionsProblem("x".repeat(MAX_OWN_INSTRUCTIONS_CHARS))).toBe(
      null,
    );
    expect(
      ownInstructionsProblem("x".repeat(MAX_OWN_INSTRUCTIONS_CHARS + 1)),
    ).toContain(String(MAX_OWN_INSTRUCTIONS_CHARS));
  });

  test("none of either is no parts, so the prompt is unchanged", () => {
    expect(instructionParts("", "", "chat")).toEqual([]);
  });

  test("the deployment's first, and they win", () => {
    const parts = instructionParts("Be formal.", "Be brief.", "chat");
    expect(parts.map((p) => p.key)).toEqual(["deployment", "person"]);
    expect(parts[0].text).toContain("these win");
    expect(parts[0].text).toContain(
      "<deployment_instructions>\nBe formal.\n</deployment_instructions>",
    );
    expect(parts[1].text).toContain(
      "<person_instructions>\nBe brief.\n</person_instructions>",
    );
    expect(parts[1].text).toContain("except where they conflict");
  });

  test("they come after everything the agent says, on their own lines", () => {
    const parts = instructionParts("A", "B", "chat");
    expect(joinParts(parts).indexOf("\n\n")).toBe(0);
    expect(parts[1].sep).toBe("\n\n");
  });

  test("a script-building run gets the deployment's only", () => {
    expect(
      instructionParts("Be formal.", "Be brief.", "author").map((p) => p.key),
    ).toEqual(["deployment"]);
    expect(instructionParts("", "Be brief.", "author")).toEqual([]);
  });
});
