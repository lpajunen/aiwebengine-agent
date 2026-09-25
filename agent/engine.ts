/**
 * Which of the engine's management tools only read.
 *
 * A module rather than a function in `main.ts` for the reason the others here
 * are: a root script cannot `export`, so anything a test needs to reach has to
 * live beside it. This one earns that more than most — it is the line between
 * what an agent may do while it is still planning and what it has to ask
 * about, and a line that is only ever read is a line nothing checks.
 *
 * **Classified by name, and it has to be.** The engine has no answer to give:
 * a tool reports what it did, not what it would do, so there is no asking
 * first. What there is instead is a naming convention the engine keeps
 * consistently — `read_file`, `list_users`, `get_deployment`, `search_files`,
 * `diff_revisions`, `check_script` read; `write_file`, `delete_asset`,
 * `add_user_role`, `revert_script`, `deploy_script`, `pull_from_git` do not.
 *
 * **Anything unrecognised counts as a write.** A tool this file has not heard
 * of is one added to the engine since, and the safe reading of an unfamiliar
 * verb is that it changes something: being asked about a read costs a turn,
 * and not being asked about a write costs whatever it changed.
 */

/**
 * The verbs the engine uses for tools that only read.
 *
 * `eval` is deliberately absent although it is spelled like a question.
 * `eval_script` runs arbitrary code against a script with the caller's
 * authority, which is the widest write there is.
 */
const READING_VERBS = [
  "read",
  "list",
  "get",
  "search",
  "diff",
  "check",
] as const;

/** Whether `name` is a tool that only reads. */
export function onlyReads(name: string): boolean {
  const verb = name.trim().toLowerCase().split("_")[0];
  return (READING_VERBS as readonly string[]).indexOf(verb) !== -1;
}

/**
 * The arguments a model wrote, as an object, or the reason they are not one.
 *
 * Separate from the call because the failure is a different kind: arguments
 * that will not parse are the model's own mistake and fixable on the next
 * turn, where a refusal from the engine is the person's account saying no.
 * Telling them apart is what stops the model retrying the second.
 */
export function parseArgs(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw && raw.trim() ? raw : "{}");
  } catch (e) {
    return { ok: false, why: "it is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, why: "it is not an object" };
  }
  if (Array.isArray(parsed)) {
    return { ok: false, why: "it is an array rather than an object" };
  }
  return { ok: true, args: parsed as Record<string, unknown> };
}
