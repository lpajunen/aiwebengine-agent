import { promptFor } from "./lib/prompts.ts";

describe("promptFor", () => {
  test("answers the prompts in order", () => {
    expect(promptFor(0)).toBe("What made you smile today?");
    expect(promptFor(1)).toBe("What did you learn today?");
    expect(promptFor(2)).toBe("What will you do differently tomorrow?");
  });
  test("starts again after the last", () => {
    expect(promptFor(3)).toBe(promptFor(0));
    expect(promptFor(7)).toBe(promptFor(1));
  });
});
