/**
 * What a turn sends the model, as parts and as the record of it.
 */

import { joinParts, requestMark, sentPromptOf } from "./context.ts";

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
