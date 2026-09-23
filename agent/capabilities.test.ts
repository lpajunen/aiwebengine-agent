/**
 * The security argument for `run_js`, as assertions rather than as prose.
 *
 * `capabilities.ts` carries a long comment saying which names are withheld and
 * why. A comment is read by whoever is already looking; these run whether or
 * not anybody is. Each case below names the harm rather than the value, so a
 * failure says what it would cost rather than that a list changed.
 */

import {
  ACT_CAPABILITIES,
  PLAN_CAPABILITIES,
  wantedCapabilities,
  withoutTheExfiltrationPair,
} from "./capabilities.ts";

describe("what a planning turn may do", () => {
  test("holds the network, the logs and the script's own assets", () => {
    expect(PLAN_CAPABILITIES).toContain("use_network");
    expect(PLAN_CAPABILITIES).toContain("view_logs");
    expect(PLAN_CAPABILITIES).toContain("read_assets");
  });

  test("cannot read a secret, which would post this person's API key", () => {
    expect(PLAN_CAPABILITIES).not.toContain("read_secrets");
  });

  test("cannot query the database, which holds every person's conversation", () => {
    expect(PLAN_CAPABILITIES).not.toContain("read_script_data");
  });

  test("cannot read storage, which beside the network is a way out", () => {
    // personalStorage is this person's notes and scriptStorage holds the
    // Telegram webhook's shared secret. Either one plus use_network is
    // private data and an unbounded destination in a single execution.
    expect(PLAN_CAPABILITIES).not.toContain("read_storage");
  });

  test("writes nothing at all", () => {
    for (const name of PLAN_CAPABILITIES) {
      expect(name.indexOf("write_")).toBe(-1);
      expect(name.indexOf("delete_")).toBe(-1);
    }
    expect(PLAN_CAPABILITIES).not.toContain("enqueue_tasks");
    expect(PLAN_CAPABILITIES).not.toContain("send_messages");
  });
});

describe("what an approval buys", () => {
  test("exactly one more name than planning", () => {
    // An approval is given on the strength of a sentence. The further the
    // granted set is from that sentence, the less the approval meant.
    expect(ACT_CAPABILITIES).toHaveLength(PLAN_CAPABILITIES.length + 1);
    expect(ACT_CAPABILITIES).toContain("write_storage");
    for (const name of PLAN_CAPABILITIES) {
      expect(ACT_CAPABILITIES).toContain(name);
    }
  });

  test("never write_script_data, which would open the gate it is gated by", () => {
    // `runs` holds the mode this list is selected by, `plans` holds the row
    // being decided, `messages` holds what the next turn reasons from. A turn
    // holding this could approve its own plan.
    expect(ACT_CAPABILITIES).not.toContain("write_script_data");
  });

  test("does not hand back the read that approval was never about", () => {
    expect(ACT_CAPABILITIES).not.toContain("read_storage");
    expect(ACT_CAPABILITIES).not.toContain("read_secrets");
    expect(ACT_CAPABILITIES).not.toContain("read_script_data");
  });
});

describe("wantedCapabilities", () => {
  test("names the two modes", () => {
    expect(wantedCapabilities("act")).toBe(ACT_CAPABILITIES);
    expect(wantedCapabilities("plan")).toBe(PLAN_CAPABILITIES);
  });

  test("anything it has never heard of is planning", () => {
    // A mode read back from a row an older or newer version of this script
    // wrote must fall to the floor, never to the wider set.
    expect(wantedCapabilities("")).toBe(PLAN_CAPABILITIES);
    expect(wantedCapabilities("unattended")).toBe(PLAN_CAPABILITIES);
    expect(wantedCapabilities("ACT")).toBe(PLAN_CAPABILITIES);
  });
});

describe("withoutTheExfiltrationPair", () => {
  test("drops the read when the network is there too", () => {
    expect(
      withoutTheExfiltrationPair(["use_network", "read_storage", "view_logs"]),
    ).toEqual(["use_network", "view_logs"]);
  });

  test("keeps the read when there is nowhere to send it", () => {
    expect(withoutTheExfiltrationPair(["read_storage", "view_logs"])).toEqual([
      "read_storage",
      "view_logs",
    ]);
  });

  test("never drops the network, which the tool cannot do without", () => {
    // Without it run_js is a calculator. The notes are a recall away; the
    // network is not reachable any other way from model-written code.
    const narrowed = withoutTheExfiltrationPair([
      "use_network",
      "read_storage",
    ]);
    expect(narrowed).toContain("use_network");
    expect(narrowed).not.toContain("read_storage");
  });

  test("leaves a list holding neither exactly as it was", () => {
    expect(withoutTheExfiltrationPair(["view_logs", "read_assets"])).toEqual([
      "view_logs",
      "read_assets",
    ]);
    expect(withoutTheExfiltrationPair([])).toEqual([]);
  });

  test("does not fire on the lists this agent actually uses", () => {
    // It is a backstop, not a step. If this case starts failing, one of the
    // lists above grew a name it should not have and the guard caught it.
    expect(withoutTheExfiltrationPair(PLAN_CAPABILITIES)).toEqual(
      PLAN_CAPABILITIES,
    );
    expect(withoutTheExfiltrationPair(ACT_CAPABILITIES)).toEqual(
      ACT_CAPABILITIES,
    );
  });
});
