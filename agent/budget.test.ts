/**
 * The arithmetic that decides when a run has had enough.
 *
 * Two of this project's three most expensive bugs were sums that looked right.
 * Neither raised anything, and both were found by a person reading a database.
 * These cases are written against the mistake rather than the behaviour, so a
 * failure says which one has come back.
 */

import {
  COMPACT_AT_ROWS,
  COMPACT_AT_TOKENS,
  HISTORY_QUERY_LIMIT,
  MAX_HISTORY_ROWS,
  costOf,
  emptySpend,
  overHistoryLimit,
  shouldCompact,
  spendLine,
  spendOf,
  stepsFrom,
  stepsSincePrompt,
} from "./budget.ts";

describe("the history ceiling", () => {
  test("the read asks for one row more than the ceiling", () => {
    // The extra row is what tells "at the limit" from "past it". Reading
    // exactly MAX_HISTORY_ROWS makes a run that has gone wrong look like one
    // that has not, which is the shape the oldest-first bug had.
    expect(HISTORY_QUERY_LIMIT).toBe(MAX_HISTORY_ROWS + 1);
  });

  test("at the ceiling is not past it", () => {
    expect(overHistoryLimit(MAX_HISTORY_ROWS - 1)).toBe(false);
    expect(overHistoryLimit(MAX_HISTORY_ROWS)).toBe(false);
    expect(overHistoryLimit(MAX_HISTORY_ROWS + 1)).toBe(true);
  });

  test("compaction is reached well before the ceiling", () => {
    // The ceiling stops a run outright. If these ever cross, a run would be
    // killed at the point it was supposed to fold itself and carry on.
    expect(COMPACT_AT_ROWS < MAX_HISTORY_ROWS).toBe(true);
    expect(COMPACT_AT_ROWS > 4).toBe(true);
  });
});

describe("shouldCompact", () => {
  test("a short conversation is left alone whatever it cost", () => {
    // Fewer than four rows has nothing worth summarising, and a first turn
    // with a large prompt — a long skill index, a big paste — would otherwise
    // pay for a summary of almost nothing.
    expect(shouldCompact(0, 0)).toBe(false);
    expect(shouldCompact(3, COMPACT_AT_TOKENS * 10)).toBe(false);
  });

  test("enough rows is enough on its own", () => {
    expect(shouldCompact(COMPACT_AT_ROWS, 0)).toBe(true);
    expect(shouldCompact(COMPACT_AT_ROWS - 1, 0)).toBe(false);
  });

  test("enough tokens is enough on its own", () => {
    expect(shouldCompact(4, COMPACT_AT_TOKENS)).toBe(true);
    expect(shouldCompact(4, COMPACT_AT_TOKENS - 1)).toBe(false);
  });
});

describe("stepsFrom", () => {
  test("takes whichever of the two is further along", () => {
    // The counter can be behind after a turn that failed to record itself;
    // the rows can be behind after a compaction replaces many assistant
    // messages with one user message. Neither may hand back a spent turn.
    expect(stepsFrom(5, 3)).toBe(5);
    expect(stepsFrom(3, 5)).toBe(5);
    expect(stepsFrom(4, 4)).toBe(4);
  });

  test("falls back to the rows when there is no counter", () => {
    // A run that predates the column, or a row that was never written.
    expect(stepsFrom(null, 7)).toBe(7);
    expect(stepsFrom(undefined, 7)).toBe(7);
    expect(stepsFrom("not a number", 7)).toBe(7);
  });

  test("a zero counter is a counter, not a missing one", () => {
    expect(stepsFrom(0, 0)).toBe(0);
    expect(stepsFrom(0, 2)).toBe(2);
  });
});

describe("stepsSincePrompt", () => {
  test("a continued conversation starts its prompt at zero", () => {
    // Twelve turns were spoken before this prompt; none of them are its.
    expect(stepsSincePrompt(0, 12, 12)).toBe(0);
    expect(stepsSincePrompt(2, 14, 12)).toBe(2);
  });

  test("a compaction below the base falls back to the counter", () => {
    expect(stepsSincePrompt(3, 1, 12)).toBe(3);
  });

  test("no base is the whole conversation", () => {
    expect(stepsSincePrompt(null, 7, null)).toBe(7);
    expect(stepsSincePrompt(null, 7, undefined)).toBe(7);
  });
});

describe("spendOf", () => {
  const turn = (cached: number, wrote: number, fresh: number, out: number) => ({
    cached_tokens: cached,
    wrote_tokens: wrote,
    fresh_tokens: fresh,
    out_tokens: out,
  });

  test("nothing spent is every field at zero", () => {
    expect(spendOf([])).toEqual(emptySpend());
    expect(emptySpend().turns).toBe(0);
  });

  test("sums the token columns and counts the turns", () => {
    const spend = spendOf([turn(10, 5, 1, 100), turn(20, 0, 2, 200)]);
    expect(spend.turns).toBe(2);
    expect(spend.cached).toBe(30);
    expect(spend.wrote).toBe(5);
    expect(spend.fresh).toBe(3);
    expect(spend.output).toBe(300);
  });

  test("largestPrompt is the biggest prompt, never the sum of them", () => {
    // The bug this pins. Every turn resends the turn before it, so adding
    // prompt sizes measures a quantity nothing spent — and the compaction
    // trigger reads this number, so a sum would fold every run early.
    const spend = spendOf([turn(10, 5, 1, 0), turn(20, 0, 2, 0)]);
    expect(spend.largestPrompt).toBe(22);
  });

  test("a later, smaller turn does not lower the largest", () => {
    const spend = spendOf([turn(900, 0, 0, 0), turn(10, 0, 0, 0)]);
    expect(spend.largestPrompt).toBe(900);
  });

  test("a row missing a column contributes zero, not NaN", () => {
    // One absent value must not turn a whole run's cost into something the
    // page renders as "NaN tokens".
    const spend = spendOf([{ cached_tokens: 5 }, {}, null]);
    expect(spend.turns).toBe(3);
    expect(spend.cached).toBe(5);
    expect(spend.output).toBe(0);
    expect(spend.largestPrompt).toBe(5);
  });
});

describe("the spend line", () => {
  const prices = {
    freshPerM: 1,
    cacheWritePerM: 2,
    cacheReadPerM: 0.5,
    outputPerM: 10,
  };

  test("each kind of token at its own rate", () => {
    const spend = {
      turns: 1,
      cached: 1000000,
      wrote: 1000000,
      fresh: 1000000,
      output: 1000000,
      largestPrompt: 0,
    };
    expect(costOf(spend, prices)).toBe(13.5);
  });

  test("turns, tokens in and out, and dollars", () => {
    const spend = {
      turns: 3,
      cached: 10000,
      wrote: 2000,
      fresh: 345,
      output: 1678,
      largestPrompt: 0,
    };
    expect(spendLine(spend, prices)).toBe(
      "3 turns · 12,345 in · 1,678 out · ≈ $0.03",
    );
  });

  test("one turn, and a cost too small to show in cents", () => {
    const spend = { ...emptySpend(), turns: 1, fresh: 10, output: 5 };
    expect(spendLine(spend, prices)).toBe("1 turn · 10 in · 5 out · ≈ <$0.01");
  });

  test("nothing spent is nothing to say", () => {
    expect(spendLine(emptySpend(), prices)).toBe("");
  });
});
