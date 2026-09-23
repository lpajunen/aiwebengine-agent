/**
 * What an approval carries, decoded.
 *
 * Every failure in `plans.ts` answers null, and the caller reports null as
 * "there was nothing to do" — which is correct and is indistinguishable from
 * success to anyone reading the chat. That is the same failure mode as the bug
 * this whole mechanism exists to fix: the model said "Done" and nothing had
 * been stored. So the cases below are mostly about which inputs must not
 * quietly become nothing, and which must.
 */

import { rememberArgs, skillWriteArgs } from "./plans.ts";

describe("rememberArgs", () => {
  test("reads back what the tool put in", () => {
    expect(rememberArgs('{"key":"tone","value":"concise"}')).toEqual({
      key: "tone",
      value: "concise",
    });
  });

  test("trims the key, because it becomes a storage key", () => {
    expect(rememberArgs('{"key":"  tone  ","value":"x"}')).toEqual({
      key: "tone",
      value: "x",
    });
  });

  test("an absent value is an empty note, not the word undefined", () => {
    // String(undefined) is what the person would have read back later.
    expect(rememberArgs('{"key":"tone"}')).toEqual({ key: "tone", value: "" });
  });

  test("keeps a value that is falsy but real", () => {
    expect(rememberArgs('{"key":"count","value":0}')).toEqual({
      key: "count",
      value: "0",
    });
    expect(rememberArgs('{"key":"flag","value":false}')).toEqual({
      key: "flag",
      value: "false",
    });
  });

  test("refuses a payload with no usable key", () => {
    expect(rememberArgs('{"value":"x"}')).toBe(null);
    expect(rememberArgs('{"key":"   "}')).toBe(null);
    expect(rememberArgs("{}")).toBe(null);
  });

  test("refuses anything that is not an object of fields", () => {
    expect(rememberArgs("not json at all")).toBe(null);
    expect(rememberArgs("null")).toBe(null);
    expect(rememberArgs("[1,2]")).toBe(null);
    expect(rememberArgs('"a string"')).toBe(null);
    expect(rememberArgs(undefined)).toBe(null);
  });
});

describe("skillWriteArgs", () => {
  test("reads back what the tool put in", () => {
    expect(
      skillWriteArgs('{"name":"email","description":"d","body":"b"}'),
    ).toEqual({ name: "email", description: "d", body: "b" });
  });

  test("refuses a name that could climb out of skills/", () => {
    // The approval was for a skill. A traversal is not a skill, and this is
    // the last place before an asset path is built from it.
    expect(skillWriteArgs('{"name":"../x","body":"b"}')).toBe(null);
    expect(skillWriteArgs('{"name":"a/b","body":"b"}')).toBe(null);
    expect(skillWriteArgs('{"name":"","body":"b"}')).toBe(null);
    expect(skillWriteArgs('{"body":"b"}')).toBe(null);
  });

  test("folds a newline in the description rather than letting it out", () => {
    // The description goes on one unquoted line of the front matter. A
    // newline would end that line early, and a following `---` would close
    // the block and take the body with it.
    expect(
      skillWriteArgs('{"name":"x","description":"one\\ntwo","body":"b"}'),
    ).toEqual({ name: "x", description: "one two", body: "b" });
    expect(
      skillWriteArgs('{"name":"x","description":"a\\n---\\nb","body":"c"}'),
    ).toEqual({ name: "x", description: "a --- b", body: "c" });
  });

  test("a missing description or body is empty rather than refused", () => {
    expect(skillWriteArgs('{"name":"x"}')).toEqual({
      name: "x",
      description: "",
      body: "",
    });
  });

  test("refuses anything that is not an object of fields", () => {
    expect(skillWriteArgs("not json")).toBe(null);
    expect(skillWriteArgs("[]")).toBe(null);
    expect(skillWriteArgs(null)).toBe(null);
  });
});
