/**
 * Decoding what an approval carries.
 *
 * A plan that defers a call carries that call — `plans` has `action` and
 * `payload` — and approving it runs the payload rather than asking the model
 * to repeat itself. That design exists because the model does not repeat
 * itself: asked to remember a preference, it raised the request, the person
 * approved, the run resumed, and the next turn said "Done" with no tool call
 * at all. Nothing was stored and the person was told otherwise.
 *
 * So this is the layer where a stored call becomes arguments again, and it is
 * the layer where getting it wrong is silent in the same way. Every failure
 * below answers `null`, which the caller reports as "there was nothing to do"
 * — correct, and indistinguishable from success if it is ever reached by
 * accident. Hence the tests.
 *
 * Apart from `main.ts` for the reason `protocol.ts` gives — a root script
 * cannot `export`.
 */

import { SKILL_NAME_PATTERN } from "./skills.ts";

/** What `remember` was going to be called with, or null if it cannot be. */
export function rememberArgs(
  payload: unknown,
): { key: string; value: string } | null {
  const args = parseObject(payload);
  if (!args) return null;

  const key = String(args.key ?? "").trim();
  if (!key) return null;

  // An absent value stores an empty note rather than the string "undefined",
  // which is what `String(undefined)` would have put in front of the person
  // the next time they read it back.
  return { key: key, value: String(args.value ?? "") };
}

/** What `write_skill` was going to be called with, or null if it cannot be. */
export function skillWriteArgs(
  payload: unknown,
): { name: string; description: string; body: string } | null {
  const args = parseObject(payload);
  if (!args) return null;

  const name = String(args.name ?? "").trim();
  if (!SKILL_NAME_PATTERN.test(name)) return null;

  // The description goes on one unquoted line of the front matter, so a
  // newline in it would end that line early and anything after it would be
  // read as another key — or, if it happened to be `---`, would close the
  // block and take the body with it. Folded to spaces rather than refused:
  // the person has already approved this plan, and a skill written with its
  // description run together reads worse than one that never landed.
  const description = String(args.description ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();

  return {
    name: name,
    description: description,
    body: String(args.body ?? ""),
  };
}

/**
 * A stored payload as a plain object, or null.
 *
 * Accepts both what the column holds and what a caller may already have
 * parsed. `JSON.parse` answers a bare `null`, a number or an array for input
 * that is valid JSON and not an object, and every one of those would reach
 * the field reads above as something without the fields.
 */
function parseObject(payload: unknown): Record<string, unknown> | null {
  let value: unknown = payload;
  if (typeof value === "string" || value === undefined || value === null) {
    try {
      value = JSON.parse(String(payload ?? "{}"));
    } catch (e) {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
