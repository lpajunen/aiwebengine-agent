import {
  AUTHOR_MAX_STEPS,
  AUTHOR_MAX_TOKENS,
  AUTHOR_TOOLS,
  CHAT_MAX_STEPS,
  CHAT_MAX_TOKENS,
  cancelTaskArgs,
  ESCALATE_AT,
  evalScriptArgs,
  failureSignature,
  handoffNote,
  findLoose,
  isAuthorTool,
  looseEdit,
  nearestRegion,
  leftoverPlaceholders,
  parseLooseJson,
  repairEscapedSource,
  readFilesArgument,
  readRemoveArgument,
  secretChange,
  secretChangeFrom,
  secretPlanText,
  MAX_SECRET_CHARS,
  revertScriptArgs,
  maxStepsFor,
  maxTokensFor,
  nextFailureCount,
  notOpenable,
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
      if (tool.name === "create_script" || tool.name === "open_script")
        continue;
      expect("script" in props).toBe(true);
    }
  });
  test("no tool names an engine operation the model could aim elsewhere", () => {
    expect(isAuthorTool("write_files")).toBe(true);
    expect(isAuthorTool("delete_script")).toBe(false);
    expect(isAuthorTool("engine_call")).toBe(false);
  });
  test("the listing stays small", () => {
    expect(JSON.stringify(AUTHOR_TOOLS).length < 8000).toBe(true);
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

describe("repairEscapedSource", () => {
  test("a file with its newlines escaped twice gets real ones", () => {
    const broken = 'function f() {\\n  return \\"a\\";\\n}\\n';
    expect(repairEscapedSource(broken)).toBe(
      'function f() {\n  return "a";\n}\n',
    );
  });
  test("a file that already has newlines is left alone", () => {
    const fine = "const a = 'x\\ny';\nconst b = 1;\n";
    expect(repairEscapedSource(fine)).toBe(fine);
  });
  test("a one-liner with a couple of escapes is left alone", () => {
    const line = 'console.log("a\\nb\\nc");';
    expect(repairEscapedSource(line)).toBe(line);
  });
  test("files read from an argument are repaired", () => {
    const r = readFilesArgument([{ path: "a.ts", text: "a;\\nb;\\nc;\\nd;" }]);
    expect(r.files[0].text).toBe("a;\nb;\nc;\nd;");
  });
});

describe("editing from memory", () => {
  const file = "function f() {\n    const x = 1;\n    return x;\n}\n";
  test("whitespace that drifted is found, and the file's own text returned", () => {
    expect(findLoose(file, "const x = 1;\nreturn x;")).toBe(
      "const x = 1;\n    return x;",
    );
  });
  test("a needle that is not there, or is there twice, finds nothing", () => {
    expect(findLoose(file, "const y = 2;")).toBe(null);
    expect(findLoose("a b\na  b\n", "a b")).toBe(null);
  });
  test("special characters in the needle are literal", () => {
    expect(findLoose("x = a.b(1) + [2]", "a.b(1) + [2]")).toBe("a.b(1) + [2]");
    expect(findLoose("x = aXb(1)", "a.b(1)")).toBe(null);
  });
  test("an edit is rewritten against the file's text without doubling indentation", () => {
    const edit = looseEdit(file, "  const x = 1;", "  const x = 2;");
    expect(edit).toEqual({
      oldString: "const x = 1;",
      newString: "const x = 2;",
    });
  });
  test("an exact match needs no rewrite", () => {
    expect(looseEdit(file, "const x = 1;", "const x = 2;")).toBe(null);
  });
  test("the nearest lines are shown, numbered", () => {
    const region = nearestRegion(file, "const total = x + 1;");
    expect(region).toContain("2:     const x = 1;");
  });
  test("nothing near is an empty string", () => {
    expect(nearestRegion(file, "zzz qqq")).toBe("");
  });
});

describe("opening an existing script", () => {
  test("an owner may", () => {
    expect(notOpenable("garden", ["u1", "u2"], "u1")).toBeNull();
  });
  test("someone who is not an owner may not, and the refusal names the script", () => {
    const why = notOpenable("garden", ["u2"], "u1");
    expect(why).toContain('"garden"');
    expect(why).toContain("owns");
  });
  test("a script with no owners, or an unreadable list, is refused", () => {
    expect(notOpenable("garden", [], "u1")).not.toBeNull();
    expect(notOpenable("garden", undefined, "u1")).not.toBeNull();
    expect(notOpenable("garden", "u1", "u1")).not.toBeNull();
  });
  test("an empty user id never matches", () => {
    expect(notOpenable("garden", [""], "")).not.toBeNull();
  });
});

describe("the arguments of tools that run outside the approval", () => {
  test("eval_script always rolls back, whatever the model asked for", () => {
    expect(evalScriptArgs("garden", { source: "1" }).rollback).toBe(true);
    expect(
      evalScriptArgs("garden", { source: "1", rollback: false }).rollback,
    ).toBe(true);
    expect(
      evalScriptArgs("garden", { source: "1", rollback: "false" }).rollback,
    ).toBe(true);
  });
  test("eval_script passes the script and snippet and nothing else", () => {
    const args = evalScriptArgs("garden", {
      source: "1 + 1",
      timeoutMs: 600000,
      script: "somebody-elses",
    });
    expect(Object.keys(args).sort()).toEqual(["rollback", "script", "source"]);
    expect(args.script).toBe("garden");
    expect(args.source).toBe("1 + 1");
  });
  test("revert_script is never forced", () => {
    const args = revertScriptArgs("garden", {
      revision: "3",
      force: true,
      dryRun: true,
    });
    expect("force" in args).toBe(false);
    expect(Object.keys(args).sort()).toEqual(["dryRun", "revision", "script"]);
  });
  test("revert_script previews only when asked to, and trims the revision", () => {
    expect(revertScriptArgs("garden", { revision: " last-good " })).toEqual({
      script: "garden",
      revision: "last-good",
      dryRun: false,
    });
    expect(
      revertScriptArgs("garden", { revision: "2", dryRun: "yes" }).dryRun,
    ).toBe(false);
  });
  test("cancel_task names one task and never discards the finished ones", () => {
    const args = cancelTaskArgs("garden", {
      task: " 42 ",
      finished: true,
      script: "somebody-elses",
    });
    expect(args).toEqual({ script: "garden", task: "42" });
    expect("finished" in args).toBe(false);
  });
});

describe("secrets", () => {
  test("a write carries the value and a delete does not", () => {
    const write = secretChange("write", "garden", {
      key: "API_KEY",
      value: "s3",
    });
    expect(write.ok && write.change).toEqual({
      script: "garden",
      key: "API_KEY",
      value: "s3",
    });
    const gone = secretChange("delete", "garden", {
      key: "API_KEY",
      value: "s3",
    });
    expect(gone.ok && "value" in gone.change).toBe(false);
  });
  test("a key that is not a plain word is refused", () => {
    for (const key of ["", " ", "a b", "x/y", "k\nx", "a".repeat(81)]) {
      expect(secretChange("delete", "garden", { key }).ok).toBe(false);
    }
  });
  test("whitespace around a key is trimmed, so the key shown is the key stored", () => {
    const asked = secretChange("delete", "garden", { key: " API_KEY\n" });
    expect(asked.ok && asked.change.key).toBe("API_KEY");
  });
  test("an empty, missing, non-string or oversized value is refused", () => {
    expect(secretChange("write", "g", { key: "K" }).ok).toBe(false);
    expect(secretChange("write", "g", { key: "K", value: "" }).ok).toBe(false);
    expect(secretChange("write", "g", { key: "K", value: 5 }).ok).toBe(false);
    expect(
      secretChange("write", "g", {
        key: "K",
        value: "x".repeat(MAX_SECRET_CHARS + 1),
      }).ok,
    ).toBe(false);
  });
  test("the plan the person reads never contains the value", () => {
    const text = secretPlanText({
      script: "garden",
      key: "API_KEY",
      value: "hunter2-very-secret",
    });
    expect(text).toContain("API_KEY");
    expect(text).toContain("garden");
    expect(text.indexOf("hunter2-very-secret")).toBe(-1);
  });
  test("a change survives the plan row, and a damaged one is not read", () => {
    const change = { script: "garden", key: "K", value: "v" };
    expect(secretChangeFrom(JSON.stringify(change))).toEqual(change);
    expect(secretChangeFrom(JSON.stringify({ script: "g", key: "K" }))).toEqual(
      {
        script: "g",
        key: "K",
      },
    );
    expect(secretChangeFrom("")).toBeNull();
    expect(secretChangeFrom("not json")).toBeNull();
    expect(secretChangeFrom(JSON.stringify({ script: "g" }))).toBeNull();
    expect(
      secretChangeFrom(JSON.stringify({ script: "g", key: "K", value: 5 })),
    ).toBeNull();
  });
});
