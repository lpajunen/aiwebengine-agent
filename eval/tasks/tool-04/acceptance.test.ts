import { daysBetween } from "./lib/dates.ts";

describe("daysBetween", () => {
  test("a leap February", () => {
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });
  test("a normal February", () => {
    expect(daysBetween("2023-02-28", "2023-03-01")).toBe(1);
  });
  test("same day", () => {
    expect(daysBetween("2024-05-05", "2024-05-05")).toBe(0);
  });
  test("negative when earlier", () => {
    expect(daysBetween("2024-01-10", "2024-01-01")).toBe(-9);
  });
  test("invalid date throws", () => {
    expect(() => daysBetween("2024-13-45", "2024-01-01")).toThrow();
  });
  test("garbage throws", () => {
    expect(() => daysBetween("tomorrow", "2024-01-01")).toThrow();
  });
});
