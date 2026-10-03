import { textStats } from "./lib/stats.ts";

describe("textStats", () => {
  test("counts a simple sentence", () => {
    expect(textStats("The quick brown fox.")).toEqual({ words: 4, characters: 20, sentences: 1, longestWord: "quick" });
  });
  test("counts several sentences", () => {
    const s = textStats("Hi! Is it ready? Yes.");
    expect(s.words).toBe(5);
    expect(s.sentences).toBe(3);
  });
  test("keeps apostrophes inside words", () => {
    expect(textStats("Don't stop").words).toBe(2);
    expect(textStats("Don't stop").longestWord).toBe("Don't");
  });
  test("empty text has nothing", () => {
    expect(textStats("")).toEqual({ words: 0, characters: 0, sentences: 0, longestWord: "" });
  });
});
