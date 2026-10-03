import {
  AUTHOR_MAX_STEPS,
  AUTHOR_MAX_TOKENS,
  AUTHOR_TOOLS,
  CHAT_MAX_STEPS,
  CHAT_MAX_TOKENS,
  ESCALATE_AT,
  failureSignature,
  handoffNote,
  isAuthorTool,
  leftoverPlaceholders,
  parseLooseJson,
  readFilesArgument,
  readRemoveArgument,
  maxStepsFor,
  maxTokensFor,
  nextFailureCount,
  runKindOf,
  scriptNameProblem,
  shouldEscalate,
  summariseCheck,
  summariseTests,
  testsPassed,
} from "./authoring.ts";

describe("budgets", () => {
  test("a chat run keeps the small ones", () => {
    expect(maxTokensFor("chat")).toBe(CHAT_MAX_TOKENS);
    expect(maxStepsFor("chat")).toBe(CHAT_MAX_STEPS);
  });
  test("an authoring run gets room to write several files", () => {
    expect(maxTokensFor("author")).toBe(AUTHOR_MAX_TOKENS);
    expect(maxStepsFor("author")).toBe(AUTHOR_MAX_STEPS);
    expect(AUTHOR_MAX_TOKENS > CHAT_MAX_TOKENS).toBe(true);
  });
  test("anything but 'author' is a chat", () => {
    expect(runKindOf("author")).toBe("author");
    expect(runKindOf("")).toBe("chat");
    expect(runKindOf(undefined)).toBe("chat");
    expect(runKindOf("admin")).toBe("chat");
  });
});

describe("scriptNameProblem", () => {
  test("accepts a slug", () => {
    expect(scriptNameProblem("garden-club")).toBe(null);
    expect(scriptNameProblem("a1")).toBe(null);
  });
  test("refuses what the engine would", () => {
    expect(scriptNameProblem("Garden")).toContain("not a usable");
    expect(scriptNameProblem("garden_club")).toContain("not a usable");
    expect(scriptNameProblem("-x")).toContain("not a usable");
    expect(scriptNameProblem("x-")).toContain("not a usable");
    expect(scriptNameProblem("a/b")).toContain("not a usable");
    expect(scriptNameProblem("x".repeat(41))).toContain("not a usable");
  });
  test("keeps clear of the templates and the agent", () => {
    expect(scriptNameProblem("template-site")).toContain("reserved");
    expect(scriptNameProblem("agent")).toContain("reserved");
  });
});

describe("summariseCheck", () => {
  test("a pass says so and lists what is registered", () => {
    const text = summariseCheck({
      ok: true,
      diagnostics: [],
      registrations: [{ kind: "route", method: "GET", name: "/hello" }],
    });
    expect(text).toContain("check: passed");
    expect(text).toContain("registers: route GET /hello");
  });
  test("a failure leads with the verdict and names each error's place", () => {
    const text = summariseCheck({
      ok: false,
      diagnostics: [
        { severity: "warning", code: "no-init", message: "w" },
        {
          severity: "error",
          code: "missing-handler",
          file: "main.ts",
          line: 12,
          message: "nothing named 'hello' is defined",
        },
      ],
    });
    expect(text).toContain("FAILED — 1 error(s), 1 warning(s)");
    expect(text).toContain("error missing-handler (main.ts:12)");
    // errors come before warnings
    expect(text.indexOf("missing-handler") < text.indexOf("no-init")).toBe(
      true,
    );
  });
  test("a report that is an error is not mistaken for a pass", () => {
    expect(summariseCheck({ error: "Permission denied" })).toContain(
      "could not run",
    );
  });
  test("many diagnostics are cut, and the cut is said", () => {
    const diagnostics = [];
    for (let i = 0; i < 12; i++) {
      diagnostics.push({ severity: "error", code: "e" + i, message: "m" });
    }
    const text = summariseCheck({ ok: false, diagnostics });
    expect(text).toContain("…and 4 more");
  });
});

describe("summariseTests", () => {
  test("a pass", () => {
    expect(summariseTests({ success: true, total: 3, passed: 3 })).toBe(
      "tests: all 3 passed",
    );
    expect(testsPassed({ success: true, total: 3 })).toBe(true);
  });
  test("no tests is not a pass, and says what to do", () => {
    expect(testsPassed({ success: false, total: 0 })).toBe(false);
    expect(summariseTests({ success: false, total: 0, cases: [] })).toContain(
      "Write a *.test.ts",
    );
  });
  test("a failure names the case and its error", () => {
    const text = summariseTests({
      success: false,
      total: 2,
      passed: 1,
      cases: [
        { name: "a", status: "passed" },
        { name: "b", file: "x.test.ts", status: "failed", error: "Expected 1" },
      ],
    });
    expect(text).toContain("1 of 2 passed");
    expect(text).toContain("- b (x.test.ts): Expected 1");
  });
});

describe("failureSignature", () => {
  const failing = (line: number) => ({
    ok: false,
    diagnostics: [
      {
        severity: "error",
        code: "missing-handler",
        file: "main.ts:" + line,
        message: "nothing named 'hello' is defined at line " + line,
      },
    ],
  });
  test("a pass has none", () => {
    expect(failureSignature("check", { ok: true })).toBe(null);
    expect(failureSignature("tests", { success: true, total: 2 })).toBe(null);
  });
  test("the same fault is the same when only a line number moved", () => {
    expect(failureSignature("check", failing(3))).toBe(
      failureSignature("check", failing(40)),
    );
  });
  test("a different fault is a different failure", () => {
    const other = {
      ok: false,
      diagnostics: [{ severity: "error", code: "init-failed", message: "x" }],
    };
    expect(
      failureSignature("check", other) ===
        failureSignature("check", failing(3)),
    ).toBe(false);
  });
  test("tests are compared by the cases that failed", () => {
    const report = {
      success: false,
      total: 2,
      cases: [{ name: "b", status: "failed", error: "Expected 1" }],
    };
    expect(failureSignature("tests", report)).toContain("b|Expected 1");
  });
});

describe("escalation", () => {
  test("the same failure counts up and a pass clears it", () => {
    let c = nextFailureCount(null, "s");
    expect(c).toEqual({ sig: "s", count: 1 });
    c = nextFailureCount(c, "s");
    expect(c).toEqual({ sig: "s", count: 2 });
    expect(shouldEscalate(c)).toBe(false);
    c = nextFailureCount(c, "s");
    expect(shouldEscalate(c)).toBe(true);
    expect(ESCALATE_AT).toBe(3);
    expect(nextFailureCount(c, null)).toBe(null);
  });
  test("a different failure starts again, since that is progress", () => {
    const c = nextFailureCount({ sig: "a", count: 2 }, "b");
    expect(c).toEqual({ sig: "b", count: 1 });
  });
});

describe("handoffNote", () => {
  test("carries everything a developer needs to start", () => {
    const note = handoffNote({
      request: "Build a sign-up page",
      script: "signup",
      revision: "7",
      lastVerdict: "check: FAILED",
      tried: ["write_files signup", "edit_file main.ts"],
      reason: "The same check failed three times.",
    });
    expect(note).toContain("Build a sign-up page");
    expect(note).toContain("`signup`, revision 7");
    expect(note).toContain("check: FAILED");
    expect(note).toContain("- edit_file main.ts");
    expect(note).toContain("nothing new is being served");
  });
  test("a run that never created a script says so", () => {
    const note = handoffNote({
      request: "r",
      script: "",
      revision: "",
      lastVerdict: "",
      tried: [],
      reason: "x",
    });
    expect(note).toContain("(not created)");
    expect(note).toContain("(nothing recorded)");
  });
});

describe("the tools", () => {
  test("every tool but create_script names the script it works on", () => {
    for (const tool of AUTHOR_TOOLS) {
      const props = (
        tool.input_schema as { properties: Record<string, unknown> }
      ).properties;
      if (tool.name === "create_script") continue;
      expect("script" in props).toBe(true);
    }
  });
  test("no tool names an engine operation the model could aim elsewhere", () => {
    expect(isAuthorTool("write_files")).toBe(true);
    expect(isAuthorTool("delete_script")).toBe(false);
    expect(isAuthorTool("engine_call")).toBe(false);
  });
  test("the listing stays small", () => {
    expect(JSON.stringify(AUTHOR_TOOLS).length < 6000).toBe(true);
  });
});

describe("leftoverPlaceholders", () => {
  test("names the starter files that are still there", () => {
    expect(
      leftoverPlaceholders(["main.ts", "lib/example.ts", "lib/length.ts"]),
    ).toEqual(["lib/example.ts"]);
  });
  test("a script with its own files has none", () => {
    expect(leftoverPlaceholders(["main.ts", "lib/length.ts"])).toEqual([]);
  });
});

describe("readFilesArgument", () => {
  test("an array of path and text", () => {
    const r = readFilesArgument([{ path: "a.ts", text: "x" }]);
    expect(r.problem).toBe(null);
    expect(r.files).toEqual([{ name: "a.ts", text: "x" }]);
  });
  test("the JSON of an array sent as a string", () => {
    const r = readFilesArgument('[{"path":"a.ts","text":"x"}]');
    expect(r.files).toEqual([{ name: "a.ts", text: "x" }]);
  });
  test("one file sent on its own, and the names a model reaches for", () => {
    const r = readFilesArgument({ name: "a.ts", content: "x" });
    expect(r.files).toEqual([{ name: "a.ts", text: "x" }]);
  });
  test("a string that is not JSON says what to send", () => {
    expect(readFilesArgument("a.ts: x").problem).toContain("not a string");
  });
  test("empty, or a file with no text, is refused with the reason", () => {
    expect(readFilesArgument([]).problem).toContain("non-empty array");
    expect(readFilesArgument([{ path: "a.ts" }]).problem).toContain(
      "has no 'text'",
    );
    expect(readFilesArgument([{ text: "x" }]).problem).toContain("no 'path'");
  });
});

describe("readRemoveArgument", () => {
  test("an array, a single path, or the JSON of an array", () => {
    expect(readRemoveArgument(["a", " b "])).toEqual(["a", "b"]);
    expect(readRemoveArgument("lib/example.ts")).toEqual(["lib/example.ts"]);
    expect(readRemoveArgument('["a","b"]')).toEqual(["a", "b"]);
    expect(readRemoveArgument(undefined)).toEqual([]);
  });
});

describe("parseLooseJson", () => {
  test("valid JSON is untouched", () => {
    expect(parseLooseJson('[{"a":"b\\nc"}]')).toEqual([{ a: "b\nc" }]);
  });
  test("a raw newline inside a string is forgiven", () => {
    const text = '[{"path":"a.ts","text":"line one\nline two"}]';
    expect(parseLooseJson(text)).toEqual([
      { path: "a.ts", text: "line one\nline two" },
    ]);
  });
  test("a raw tab and an escaped quote survive", () => {
    const text = '{"t":"a\tb \\"q\\""}';
    expect(parseLooseJson(text)).toEqual({ t: 'a\tb "q"' });
  });
  test("anything else still fails", () => {
    expect(() => parseLooseJson("[{path: a.ts}]")).toThrow();
  });
  test("a file list with newlines in its text is read", () => {
    const sent = '[{"path":"a.ts","text":"x\ny"}]';
    expect(readFilesArgument(sent).files).toEqual([
      { name: "a.ts", text: "x\ny" },
    ]);
  });
});
