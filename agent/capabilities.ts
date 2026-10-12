/**
 * What model-written code is allowed to do, and the one pairing it is not.
 *
 * Apart from `main.ts` for the reason `protocol.ts` gives — a root script
 * cannot `export`, so a list a test can read has to be a module. That is a
 * better fit here than it is anywhere else in this agent: the lists below are
 * the whole of the security argument for `run_js`, and an argument that is
 * only ever read is one nothing checks.
 *
 * What crosses this boundary is a mode as a plain string rather than a
 * `RunMode`, because the module loader has no `import type` and a value import
 * of a type compiles to a `const` bound to nothing. So the narrowing is total:
 * anything that is not `"act"` is planning, which is the floor, and a mode
 * this file has never heard of therefore gets the smaller set rather than a
 * crash or the larger one.
 *
 * Covered by `capabilities.test.ts`.
 */

/**
 * What model-written code is allowed to do.
 *
 * This is the whole of the security argument for `run_js`, so it is a list of
 * three names and a list of what is deliberately missing.
 *
 * A tool call is one verb per round trip, and a run gets twelve. Code is the
 * other shape: a loop, a condition and an intermediate value cost one call
 * between them. Every project that adopts it has to build a sandbox first —
 * here the sandbox is what the script was already running inside, and
 * `sandbox.run` is the engine handing a script a way to run *part* of itself
 * holding less than it holds. The checks sit underneath the JavaScript, so
 * nothing the model writes, and no arrangement of the transcript, reaches past
 * them. A filtered tool list can be argued past; this cannot.
 *
 * What is granted:
 *
 * - `view_logs` is `console`, and on a turn that failed it is usually the only
 *   part worth reading.
 * - `use_network` is `fetch` and `fetchAll`, and is most of the reason to have
 *   the tool at all — without it this is a calculator.
 * - `read_assets` is the script's own files, which is where a skill keeps the
 *   data it points the model at.
 *
 * What is withheld, each for its own reason rather than out of caution:
 *
 * - **`read_secrets`.** It gates `{{secret:...}}` inside a `fetch`, which the
 *   engine substitutes host-side for whoever the run belongs to. Granted here,
 *   three lines of model-written code would post this person's API key to a
 *   URL of the model's choosing, and there is no version of that which is
 *   acceptable. It is also what stops the code spending their money on model
 *   calls of its own.
 * - **`read_script_data`.** `database.query` is scoped to the *script*, not to
 *   the person. This script's tables hold every run every person has ever had,
 *   so granting it would let one person's turn read another's conversation and
 *   hand it back as a tool result.
 * - **`read_storage`.** It covers both stores: `personalStorage`, which is
 *   this person's notes, and `scriptStorage`, which holds the Telegram
 *   webhook's shared secret. Either beside `use_network` is private data and a
 *   way out inside one execution. The host list narrows the way out to what
 *   the person named, and a site they named may still be one anybody can
 *   post to and read back from. Notes reach the loop through `recall` and `list_memories`
 *   instead. That costs a turn and buys the property worth having — code
 *   cannot walk the store by itself, so a note only reaches a URL if the
 *   *model* carries it there through the transcript, in text a person can read
 *   in the activity log. It is the boundary CaMeL and the dual-LLM pattern
 *   draw, and it is the most this file can draw on its own.
 * - **Every write.** Nothing here writes: not storage, not the database, not
 *   assets, not the queue. A wrong read costs a token and a wrong write costs
 *   a rollback, and the place to spend that asymmetry is the approval step —
 *   which exists, and hands [`ACT_CAPABILITIES`] back exactly one of these
 *   names. `remember` is the one write the model has without asking, and it
 *   asks on its own behalf rather than being refused.
 *
 * What is left of the risk. Untrusted content arrives — through anything the
 * code fetches, and through a chat — and is read by a turn holding
 * `use_network`. Nothing beside it can *read* private data, so the trifecta is
 * two legs here rather than three, and the third is bounded too: `run_js`
 * passes `sandbox.run` the hosts the person or the deployment named
 * (`hosts.ts`), so what a note can be carried to is not the fetched page's
 * choice. Who sent a message is not the question: a fetched page is untrusted
 * content too, and an unknown sender never gets a run, since `enqueueFrom`
 * resolves a stranger to nobody.
 *
 * Intersected with `sandbox.held()` rather than passed as written: `run` throws
 * when asked to keep something the caller does not hold, and a delegation grant
 * is free to be narrower than this list. Asking for what is there and taking
 * what is given keeps a read-only grant working instead of failing every call.
 */
export const PLAN_CAPABILITIES: Capability[] = [
  "view_logs",
  "use_network",
  "read_assets",
];

/**
 * What the same code may do once a person has said yes.
 *
 * One capability wider, and the narrowness is the point rather than a first
 * instalment. A plan is approved on the strength of what it said it would do,
 * and the further the granted set is from that sentence the less the approval
 * meant.
 *
 * **`write_script_data` is not here and should never be.** It is the one name
 * that would let model-written code reach this agent's own control plane: the
 * `runs` table holds the state every stop goes through and the mode this
 * constant is selected by, `plans` holds the row a person is being asked to
 * decide, and `messages` holds the conversation the next turn reasons from. A
 * turn holding it could approve its own plan, un-cancel itself, or rewrite
 * what it was asked to do — so the approval gate would be a gate the thing
 * being gated can open. Reading them is refused for a different reason (they
 * hold every person's rows, not just this one's), but this is the reason that
 * does not soften with time.
 *
 * `enqueue_tasks` and `send_messages` are absent for a smaller reason: a turn
 * that can start work is a turn that can outlive the approval it was given,
 * and neither has been asked for yet. They are available to add; the one above
 * is not.
 *
 * `write_storage` arriving without `read_storage` is the pair deliberately
 * broken rather than half-built. A write is not a way out, so exfiltration
 * has no use for it; and an approval is a person agreeing to a plan, which is
 * not a reason to widen what the same run may *read* and then send.
 * What it costs is read-modify-write inside one execution, and `recall` does
 * that in a turn. `personalStorage.length` and `key(i)` refuse in an approved
 * run too, which is what `list_memories` is for.
 */
export const ACT_CAPABILITIES: Capability[] = PLAN_CAPABILITIES.concat([
  "write_storage",
]);

/**
 * The list a mode asks for, before what this turn actually holds narrows it.
 *
 * Total on purpose. `"act"` is the only name that widens anything, so a mode
 * read back from a row written by an older version of this script — or by a
 * future one with a third rung — gets the floor instead of an exception or,
 * far worse, the wider set by default.
 */
export function wantedCapabilities(mode: string): Capability[] {
  return mode === "act" ? ACT_CAPABILITIES : PLAN_CAPABILITIES;
}

/**
 * The one pairing this file will not hand out, checked rather than remembered.
 *
 * `use_network` and `read_storage` in a single sub-execution are private data
 * and a way out, and the way out has no destination dimension — so it is a way
 * to anywhere, and untrusted content reaches the turn choosing it through
 * every page the same capability fetches. The lists above are written so that
 * this never fires. It is here because the next person to widen them will be
 * adding a name for a good reason with a comment in front of them, and a
 * comment is not a check.
 *
 * `use_network` is what survives, because it is the one name `run_js` cannot
 * do without — without it the tool is a calculator, and the notes are a
 * `recall` away.
 *
 * Worth being honest about what this is: policy in a script, not enforcement
 * under the JavaScript, and the same distinction `remember` makes about its
 * own gate. The difference is that this one guards a list this module is the
 * sole author of, so there is no second way to reach it — unlike a capability
 * the turn genuinely holds, which a script's check can only ask about.
 */
export function withoutTheExfiltrationPair(
  granted: Capability[],
): Capability[] {
  if (
    granted.indexOf("use_network") === -1 ||
    granted.indexOf("read_storage") === -1
  ) {
    return granted;
  }
  console.log(
    "agent: refusing to grant use_network and read_storage to one " +
      "sub-execution; dropping read_storage. See PLAN_CAPABILITIES.",
  );
  return granted.filter((name) => name !== "read_storage");
}
