import { parseIssResponse } from "./lib/iss.ts";

describe("parseIssResponse", () => {
  test("converts the strings to numbers", () => {
    expect(parseIssResponse({ message: "success", timestamp: 1700000000, iss_position: { latitude: "12.5", longitude: "-45.1" } }))
      .toEqual({ latitude: 12.5, longitude: -45.1, timestamp: 1700000000 });
  });
  test("a failure message throws", () => {
    expect(() => parseIssResponse({ message: "error" })).toThrow();
  });
  test("a non-object throws", () => {
    expect(() => parseIssResponse(null)).toThrow();
  });
});
