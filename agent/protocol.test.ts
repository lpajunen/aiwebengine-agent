/**
 * The first regression suite this agent has had.
 *
 * It covers `protocol.ts` because that is where a mistake is silent. Every
 * expensive bug this project has found so far was found by a person reading a
 * database or a log — an oldest-first `LIMIT` that served one run its first
 * sixty rows forever, an agent saying it had saved a note it had not, a
 * thirty-second ceiling on every model call — and none of them raised
 * anything. Text handling fails the same way: a half-decoded escape is a wrong
 * character on somebody's screen, not an exception.
 *
 * Run with `POST /engine/run_tests` with `{"uri": "<this script>"}`, or the `run_tests` tool.
 */

import {
  frameData,
  jsonStringPrefix,
  proseKindFor,
  readErrorMessage,
  unescapeOne,
} from "./protocol.ts";

describe("frameData", () => {
  test("joins every data line of a frame, in order", () => {
    expect(frameData("data: one\ndata: two")).toBe("one\ntwo");
  });

  test("strips one space after the colon and no more", () => {
    // The separator is a single space. A second one is content, and eating it
    // would trim the model's own indentation out of a code block.
    expect(frameData("data:  two spaces")).toBe(" two spaces");
    expect(frameData("data:none")).toBe("none");
  });

  test("ignores every field that is not data", () => {
    expect(frameData("event: content_block_delta\nid: 7\ndata: kept")).toBe(
      "kept",
    );
    expect(frameData(": a comment\nretry: 100")).toBe("");
  });

  test("a bare data line is an empty string rather than nothing", () => {
    expect(frameData("data:")).toBe("");
    expect(frameData("data: a\ndata:\ndata: b")).toBe("a\n\nb");
  });
});

describe("jsonStringPrefix", () => {
  test("reads a field that is complete", () => {
    expect(jsonStringPrefix('{"text": "hello"}', "text")).toBe("hello");
  });

  test("reads as much of an unterminated string as exists", () => {
    // The whole reason this function is not `JSON.parse`. The object is
    // half-written by definition: waiting for it to close is waiting for the
    // answer, which is the thing streaming exists to stop.
    expect(jsonStringPrefix('{"text": "hello wor', "text")).toBe("hello wor");
  });

  test("is empty when the key is absent or its value has not opened", () => {
    expect(jsonStringPrefix('{"other": "hello"}', "text")).toBe("");
    expect(jsonStringPrefix('{"text":', "text")).toBe("");
    expect(jsonStringPrefix('{"text": ', "text")).toBe("");
  });

  test("is empty when the value is not a string", () => {
    expect(jsonStringPrefix('{"text": 12', "text")).toBe("");
    expect(jsonStringPrefix('{"text": null', "text")).toBe("");
  });

  test("decodes the short escapes", () => {
    expect(jsonStringPrefix('{"text": "a\\nb\\tc"}', "text")).toBe("a\nb\tc");
    expect(jsonStringPrefix('{"text": "say \\"hi\\""}', "text")).toBe(
      'say "hi"',
    );
    expect(jsonStringPrefix('{"text": "a\\\\b"}', "text")).toBe("a\\b");
  });

  test("decodes a complete \\u escape", () => {
    expect(jsonStringPrefix('{"text": "caf\\u00e9"}', "text")).toBe("café");
  });

  test("stops before a truncated escape rather than guessing", () => {
    // `\u00` is not yet a character. Half of one on screen is worse than a
    // character arriving with the next frame.
    expect(jsonStringPrefix('{"text": "caf\\u00', "text")).toBe("caf");
    expect(jsonStringPrefix('{"text": "caf\\u', "text")).toBe("caf");
    expect(jsonStringPrefix('{"text": "line\\', "text")).toBe("line");
  });

  test("takes the first occurrence of the key, which is where the model puts it", () => {
    // Documented rather than defended. A tool call's arguments are the only
    // object this reads, and JSON cannot carry an unescaped quote inside a
    // string, so the marker can match a key and nothing else.
    expect(
      jsonStringPrefix('{"text": "first", "text": "second"}', "text"),
    ).toBe("first");
  });
});

describe("unescapeOne", () => {
  test("maps the control escapes and passes the rest through", () => {
    expect(unescapeOne("n")).toBe("\n");
    expect(unescapeOne("t")).toBe("\t");
    expect(unescapeOne("r")).toBe("\r");
    expect(unescapeOne("b")).toBe("\b");
    expect(unescapeOne("f")).toBe("\f");
    expect(unescapeOne('"')).toBe('"');
    expect(unescapeOne("\\")).toBe("\\");
    expect(unescapeOne("/")).toBe("/");
  });
});

describe("readErrorMessage", () => {
  test("prefers what the API said", () => {
    expect(
      readErrorMessage('{"error": {"message": "credit balance is too low"}}'),
    ).toBe("credit balance is too low");
  });

  test("falls back to the body when there is no message to find", () => {
    expect(readErrorMessage("<html>502 Bad Gateway</html>")).toBe(
      "<html>502 Bad Gateway</html>",
    );
    expect(readErrorMessage('{"error": {}}')).toBe('{"error": {}}');
    expect(readErrorMessage("")).toBe("");
  });

  test("bounds the fallback, because it is stored and resent every turn", () => {
    expect(readErrorMessage("x".repeat(500))).toHaveLength(200);
  });
});

describe("proseKindFor", () => {
  test("text with no tool call is the answer", () => {
    // A turn that calls no tool ends the run, so this text is the last thing
    // the person hears whether or not the model used write_response. Filing it
    // as a note is how an answer arrives in the voice meant for the model
    // talking to itself — which happened, and is why this rule exists.
    expect(proseKindFor([{ type: "text" }])).toBe("response");
    expect(proseKindFor([])).toBe("response");
  });

  test("text beside a tool call is narration", () => {
    expect(
      proseKindFor([
        { type: "text" },
        { type: "tool_use", id: "t1", name: "run_js" },
      ]),
    ).toBe("note");
  });

  test("a tool_use missing its id or name is not one", () => {
    // A block still being streamed has the type before it has either field.
    // Treating it as a call would file the turn's answer as a note.
    expect(proseKindFor([{ type: "tool_use", name: "run_js" }])).toBe(
      "response",
    );
    expect(proseKindFor([{ type: "tool_use", id: "t1" }])).toBe("response");
    expect(proseKindFor([{ type: "tool_use" }])).toBe("response");
  });
});
