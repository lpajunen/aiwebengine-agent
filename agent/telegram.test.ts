/**
 * Which conversation a Telegram message goes to.
 */

import {
  CONVERSATION_IDLE_MS,
  newConversationCommand,
  routeMessage,
} from "./telegram.ts";

const NOW = 10 * CONVERSATION_IDLE_MS;

function run(state: string, idleMs: number) {
  return {
    run_id: "r1",
    run_state: state,
    created_ms: NOW - idleMs - 1000,
    updated_ms: NOW - idleMs,
  };
}

describe("the new-conversation command", () => {
  test("plain text is not a command", () => {
    expect(newConversationCommand("hello")).toEqual({
      fresh: false,
      text: "hello",
    });
  });

  test("/new alone starts fresh with nothing to say", () => {
    expect(newConversationCommand("/new")).toEqual({ fresh: true, text: "" });
  });

  test("the words after /new are the first prompt", () => {
    expect(newConversationCommand("/new  what is this?")).toEqual({
      fresh: true,
      text: "what is this?",
    });
  });

  test("/start, a bot name and any case count", () => {
    expect(newConversationCommand("/start").fresh).toBe(true);
    expect(newConversationCommand("/NEW@agent_bot hi")).toEqual({
      fresh: true,
      text: "hi",
    });
  });

  test("a longer word that begins with new is not the command", () => {
    expect(newConversationCommand("/newsletter").fresh).toBe(false);
  });
});

describe("routing", () => {
  test("a chat with no run starts one", () => {
    expect(routeMessage(null, NOW, 0, false, false)).toEqual({ kind: "start" });
  });

  test("a recent finished run is continued", () => {
    expect(routeMessage(run("done", 60_000), NOW, 0, false, false)).toEqual({
      kind: "continue",
      runId: "r1",
    });
  });

  test("a cancelled run is continued too, as on the page", () => {
    expect(routeMessage(run("cancelled", 0), NOW, 0, false, true).kind).toBe(
      "continue",
    );
  });

  test("a run idle past the window is left behind", () => {
    expect(
      routeMessage(run("done", CONVERSATION_IDLE_MS + 1), NOW, 0, false, false),
    ).toEqual({ kind: "start" });
  });

  test("/new starts fresh however recent the run", () => {
    expect(routeMessage(run("done", 0), NOW, 0, true, false)).toEqual({
      kind: "start",
    });
  });

  test("a run from before a bare /new is left behind", () => {
    const latest = run("done", 0);
    expect(
      routeMessage(latest, NOW, Number(latest.created_ms) + 1, false, false),
    ).toEqual({ kind: "start" });
    expect(
      routeMessage(latest, NOW, Number(latest.created_ms) - 1, false, false)
        .kind,
    ).toBe("continue");
  });

  test("words for a working run are said to it", () => {
    expect(routeMessage(run("running", 0), NOW, 0, false, false)).toEqual({
      kind: "say",
      runId: "r1",
    });
    expect(routeMessage(run("waiting", 0), NOW, 0, false, false).kind).toBe(
      "say",
    );
  });

  test("files for a working run are refused, since only a prompt carries them", () => {
    expect(routeMessage(run("running", 0), NOW, 0, false, true)).toEqual({
      kind: "busy",
      runId: "r1",
    });
  });

  test("a run that says it is working but went quiet is not spoken to", () => {
    expect(
      routeMessage(
        run("running", CONVERSATION_IDLE_MS + 1),
        NOW,
        0,
        false,
        false,
      ),
    ).toEqual({ kind: "start" });
  });
});
