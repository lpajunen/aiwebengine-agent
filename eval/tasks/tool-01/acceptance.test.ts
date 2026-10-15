import { convertLength } from "./lib/length.ts";

describe("convertLength", () => {
  test("km to m", () => {
    expect(convertLength(2, "km", "m")).toBe(2000);
  });
  test("m to m", () => {
    expect(convertLength(5, "m", "m")).toBe(5);
  });
  test("mi to km", () => {
    expect(convertLength(1, "mi", "km")).toBeCloseTo(1.609344, 4);
  });
  test("ft to m", () => {
    expect(convertLength(10, "ft", "m")).toBeCloseTo(3.048, 3);
  });
  test("unknown unit throws", () => {
    expect(() => convertLength(1, "furlong", "m")).toThrow();
  });
});
