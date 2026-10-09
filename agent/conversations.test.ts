/**
 * The conversation list's paging, and the rows older conversations are given.
 */

import {
  CONVERSATION_TABLES,
  conversationTitle,
  legacyRuns,
  pageOf,
} from "./conversations.ts";

describe("titles", () => {
  test("the first prompt on one line", () => {
    expect(conversationTitle("  Plan a\n trip  ")).toBe("Plan a trip");
  });

  test("a long prompt is cut, and the cut is shown", () => {
    const title = conversationTitle("x".repeat(100));
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
  });

  test("no prompt is an empty title", () => {
    expect(conversationTitle(undefined)).toBe("");
  });
});

describe("paging", () => {
  test("a short list is the whole list", () => {
    expect(pageOf([{ updated_ms: 3 }, { updated_ms: 2 }], 2)).toEqual({
      items: [{ updated_ms: 3 }, { updated_ms: 2 }],
      next: null,
    });
  });

  test("the extra row means there is more, and the cursor is the last shown", () => {
    expect(
      pageOf([{ updated_ms: 9 }, { updated_ms: 8 }, { updated_ms: 7 }], 2),
    ).toEqual({ items: [{ updated_ms: 9 }, { updated_ms: 8 }], next: 8 });
  });
});

describe("conversations older than the runs table", () => {
  const prompts = [
    { user_id: "u", run_id: "a", message: "First\nprompt", created_ms: 10 },
    { user_id: "u", run_id: "b", message: "Has a row", created_ms: 11 },
    { user_id: "u", run_id: "a", message: "Second", created_ms: 20 },
    { user_id: "v", run_id: "a", message: "Someone else's", created_ms: 30 },
  ];

  test("each gets one row, titled and timed by its prompts", () => {
    const rows = legacyRuns(prompts, new Set(["u|b"]));
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      user_id: "u",
      run_id: "a",
      run_state: "done",
      run_mode: "plan",
      run_kind: "chat",
      steps: 0,
      title: "First prompt",
      created_ms: 10,
      updated_ms: 20,
    });
  });

  test("the same run id under two people is two conversations", () => {
    const rows = legacyRuns(prompts, new Set(["u|b"]));
    expect(rows[1].user_id).toBe("v");
  });

  test("a conversation that already has a row is left alone", () => {
    expect(legacyRuns(prompts, new Set(["u|a", "u|b", "v|a"]))).toEqual([]);
  });
});

describe("deleting", () => {
  test("every table keyed by run is cleared, the run's own row last", () => {
    expect(CONVERSATION_TABLES).toContain("attachments");
    expect(CONVERSATION_TABLES).toContain("messages");
    expect(CONVERSATION_TABLES[CONVERSATION_TABLES.length - 1]).toBe("runs");
  });
});
