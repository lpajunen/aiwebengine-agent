/**
 * The line between reading and changing, as assertions rather than as prose.
 *
 * `engine.ts` decides which management tools a planning turn may call without
 * asking anybody. Getting it wrong in one direction spends a turn; in the
 * other it changes somebody's engine without the person being asked, which is
 * the half of plan mode that matters.
 */

import { onlyReads, parseArgs } from "./engine.ts";

describe("which tools only read", () => {
  test("the engine's reading verbs are recognised", () => {
    for (const name of [
      "read_file",
      "read_logs",
      "list_users",
      "list_files",
      "list_revisions",
      "get_deployment",
      "get_git_status",
      "search_files",
      "diff_revisions",
      "check_script",
    ]) {
      expect(onlyReads(name)).toBe(true);
    }
  });

  test("everything that changes something needs asking about", () => {
    for (const name of [
      "write_file",
      "write_asset",
      "write_secret",
      "delete_file",
      "delete_asset",
      "add_user_role",
      "remove_user_role",
      "set_user_realm",
      "revert_script",
      "deploy_script",
      "pull_from_git",
      "push_to_git",
      "clear_logs",
      "cancel_task",
      "edit_file",
      "run_tests",
    ]) {
      expect(onlyReads(name)).toBe(false);
    }
  });

  test("eval_script is a write however it is spelled", () => {
    // It reads like a question and runs arbitrary code with the caller's
    // authority, which is the widest write the engine has.
    expect(onlyReads("eval_script")).toBe(false);
  });

  test("a tool this file has not heard of counts as a write", () => {
    // The direction that costs a turn rather than the one that costs whatever
    // it changed.
    expect(onlyReads("rotate_everything")).toBe(false);
    expect(onlyReads("")).toBe(false);
    expect(onlyReads("readington")).toBe(false);
  });

  test("the verb is the whole first segment, not a prefix of it", () => {
    // `readington_users` starting with "read" must not read as a read.
    expect(onlyReads("reader_of_secrets")).toBe(false);
    expect(onlyReads("listen_to_everything")).toBe(false);
  });

  test("case and padding do not change the answer", () => {
    expect(onlyReads("  LIST_USERS  ")).toBe(true);
    expect(onlyReads("Write_File")).toBe(false);
  });
});

describe("the arguments a model wrote", () => {
  test("an object comes back as one", () => {
    const parsed = parseArgs('{"uri": "x", "limit": 2}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.uri).toBe("x");
      expect(parsed.args.limit).toBe(2);
    }
  });

  test("nothing at all is an empty object, since many tools take none", () => {
    for (const raw of ["", "   ", "{}"]) {
      const parsed = parseArgs(raw);
      expect(parsed.ok).toBe(true);
    }
  });

  test("anything that is not an object says which way it is wrong", () => {
    expect(parseArgs("not json").ok).toBe(false);
    expect(parseArgs("[1, 2]").ok).toBe(false);
    expect(parseArgs("null").ok).toBe(false);
    expect(parseArgs('"a string"').ok).toBe(false);

    const asArray = parseArgs("[1, 2]");
    if (!asArray.ok) expect(asArray.why).toContain("array");
  });
});
