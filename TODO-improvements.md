# Improvements

What this agent has: a prompt box, an SSE activity log that fills in as the
model writes, a Telegram bot answering out of the same run, five tools —
`write_response`, `remember`, `list_memories`, `recall` and `run_js` — plus up
to three more when a run is planning or the deployment has skills, per-person
keys, a durable turn chain that folds itself into a summary rather than filling
up, plan and act modes enforced under the JavaScript, a cached prompt, a
per-run cost display, and a stop button. The README describes how each works.

This file is what is not built: the status tables say what is, checked against
`agent/main.ts` and `types/aiwebengine.d.ts`; the rest is the open work.

## Status

Checked against `agent/main.ts` and `types/aiwebengine.d.ts` rather than
assumed.

### Context

| Item                       | State      | Where, or what it waits on                                                    |
| -------------------------- | ---------- | ----------------------------------------------------------------------------- |
| Skills, read by the model  | Built      | `skills/<name>/SKILL.md`, the index in the prompt, `read_skill`               |
| Skills the agent writes    | Built      | `write_skill`; always asks, and writes where the approval is                  |
| `remember` / `recall`      | Built      | `personalStorage`, per person                                                 |
| `list_memories`            | Built      | key, size and first line — the index `recall` needed                          |
| Memory the person can read | Built      | `/agent/memories`, a panel above the log                                      |
| Compaction                 | Built      | `COMPACT_AT_TOKENS`, at the top of a turn and nowhere else                    |
| Prompt caching             | Built      | one breakpoint, at the end of the conversation                                |
| Project instructions       | Ahead      | an asset for the deployment's text, `personalStorage` for theirs              |
| Attachments and images     | Ahead      | all three paths are open now; `fetch(url, { binary: true })` was the last one |
| Slash commands             | Superseded | by skills — what is missing is an entry point, not a second library           |

### Tools

| Item                              | State         | Where, or what it waits on                                      |
| --------------------------------- | ------------- | --------------------------------------------------------------- |
| `run_js` — code as the action     | Built         | `runJsTool` over `sandbox.run`, narrowed by mode                |
| Mounting a third-party MCP server | Ahead         | `McpClient` is in the API; it also imports untrusted content    |
| Mounting the engine's own tools   | Open question | a token mounted this way would launder the delegation ceiling   |
| Subagents                         | Ahead         | the fourth use of the suspended run, with a lane of their own   |
| Background work                   | Ahead         | start it, keep talking, be told when it lands                   |
| Tool search, deferred schemas     | Superseded    | by `run_js` — the tool list is the thing that now does not grow |
| Hooks                             | Superseded    | `runTool` plus the deferred action already is this              |
| Structured questions              | Superseded    | `plans`, rendered as buttons                                    |

### Run control

| Item                            | State            | Where, or what it waits on                                      |
| ------------------------------- | ---------------- | --------------------------------------------------------------- |
| Streaming                       | Built            | `fetchStream` → `readModelStream`, reading half-written JSON    |
| Cancel and interject            | Built            | `cancelRun`, `interject`; a run has a row                       |
| Plan mode and act mode          | Built, enforced  | `PLAN_CAPABILITIES` / `ACT_CAPABILITIES`, `capabilitiesFor`     |
| A run that suspends and resumes | Built            | `request_approval` suspends, `decide` resumes                   |
| Per-tool approval               | Built            | a plan carries `action` and `payload`, so approving performs it |
| Cost and token accounting       | Built, page only | `turn_usage`; a run answered on a channel reports nothing       |
| Checkpoints and rewind          | Ahead            | `revisions.rs`, over what the agent writes                      |
| Session management              | Ahead            | the rows are per run; the page knows about one                  |
| Model and effort per run        | Ahead            | four things move with the tier, not one                         |

### Channels and presentation

| Item                        | State           | Where, or what it waits on                                |
| --------------------------- | --------------- | --------------------------------------------------------- |
| Telegram                    | Built           | `handleTelegram` onward; approvals arrive as buttons      |
| Further adapters            | Ahead           | Slack needs no engine change; email cannot be signed      |
| A lane per conversation     | Open question   | one lane per person now holds a chat behind a browser tab |
| It starts the conversation  | Ahead           | `enqueue({ runAt })` — no engine change                   |
| Artifacts                   | Ahead, reshaped | `personalStorage` behind a route, **not** the asset store |
| Markdown, diffs, images out | Ahead           | presentation, on the page                                 |

### Gaps this file has no section for

Three things that belong on this list and have no section of their own.

- **A regression suite.** 77 cases over five pure modules (`protocol`,
  `capabilities`, `budget`, `skills`, `plans`). An agent saying it saved a note
  it had not is covered at its decode layer, not at its effects.
- **Spend on a channel.** "Each person pays with their own key, so the bill is
  theirs to see" is true on the page and false everywhere else.
- **Approval provenance.** An approval can only carry out what the _approver's_
  context may hold — which is why a skill approved from Telegram is refused.
  That is a general rule and will bind every deferred action after this one.

## Open work

Roughly in the order it matters.

### Where `run_js` may send

Untrusted content reaches a run through anything `run_js` fetches, and the same
call can send. **Exfiltration needs no write capability**, so the defence is the
destination, not the data: `sandbox.run(source, { capabilities, hosts })` bounds
where a sub-execution may go, checked on every redirect hop and on `McpClient`.
`run_js` does not pass `hosts` yet. The list is the whole of the value — too
wide buys nothing, too narrow stops the model doing what it was asked; the shape
that probably fits is the model provider plus whatever the person's own prompt
named.

Until then the rule `capabilitiesFor` encodes stands: **nothing that reads
private data shares an execution with `use_network`** — which is why `run_js`
holds no `read_storage`, and notes reach code only as literals the model
carries through the transcript, in text the activity log shows.

### The Telegram webhook secret

`TELEGRAM_WEBHOOK_SECRET_KEY` lives in `scriptStorage` so the handler can
compare it. `crypto.secretEquals` compares a stored secret host-side, in
constant time, without returning it, so the secret can move to
`secretStorage`. It changes the setup instructions, so it goes with them.

### Tests that run where the code runs

The 77 cases run under a stand-in for `test`, `describe` and `expect`; none has
run under the engine's `run_tests`. After that, the parts that are not pure: the
state machine in `setRunState`, the ordering in `decide`, the swap in
`compactRun`. Each needs a fake of something.

### Context

- **Project instructions.** An asset for the deployment's own text and a
  `personalStorage` entry for the person's, concatenated onto `SYSTEM_PROMPT`.
- **Attachments and images.** An upload from the page is already base64
  (`request.files[].data`); an image named by URL is fetched by the API itself;
  a Telegram photo arrives as a `file_id`, takes a `getFile` call, and then
  `fetch(fileUrl, { binary: true }).bodyBase64` is the content block.

### Tools

- **Mounting a third-party MCP server.** `McpClient` is in the API. It imports
  untrusted content into a run that can reach the network, so it comes after
  the host list above.
- **Mounting the engine's own tools.** The engine is an MCP server with
  `read_file`, `write_file`, `edit_file`, `search_files`, `run_tests`,
  `check_script`, `eval_script`, `read_logs`, revisions and git sync — the whole
  loop a coding agent needs. The question is the credential: `new
McpClient(url, secret)` resolves a stored token host-side, so a delegated turn
  holding an owner's token would hold, through a credential, authority the
  delegation grant did not give it. A delegation can carry `author` or
  `administer` scopes when the person ticks them, which may make a stored token
  unnecessary; the engine side is the first Security item in its `ROADMAP.md`.
- **Subagents** — an isolated context whose tool output never enters the
  parent's transcript — and **background work** — start something long, keep
  talking, be told when it lands. Both need the run to suspend and be resumed,
  the same machinery `request_approval` uses; a subagent needs a lane of its
  own, since the default lane is the person.
- **A second narrowing.** `sandbox.run` is called only by `run_js`; a planning
  turn could hold fewer capabilities than `run_js` already does.
- **`fetchAll` in the turn loop.** The loop runs tools in sequence; only
  model-written code can reach `fetchAll` today.

### Run control

- **Checkpoints and rewind.** A page over `list_revisions`, `diff_revisions` and
  `revert_script` for what the agent writes (skills, first). A revision is per
  script, not per file, so a skill's history is `file_history`, and reverting
  lands the whole script.
- **Session management.** Resuming, listing past runs, forking from a turn. The
  rows are per run; the page shows one.
- **Spend on a channel.** A Telegram run spends the person's key with no
  display. `turn_usage` is written either way, so this is delivery — a line
  under the answer.
- **Model and effort per run.** A tier is four things that move together —
  model string, `PRICES`, the thinking/effort shape, and the minimum cacheable
  prefix (4096 tokens on `claude-haiku-4-5`), which prompt caching turns on —
  so it wants to be one record before it can be a choice.

### Channels and presentation

- **Further adapters.** Slack authenticates with a bearer header and needs no
  engine change; email cannot be signed, so its sender cannot be verified.
- **A lane per conversation.** One lane per person means a message from a phone
  waits behind whatever the browser is doing; one per conversation lets two
  runs for one person interleave writes to the same notes. It is a question
  about what a conversation is, and the `runs` table has the `channel` and
  `chat_id` to answer it.
- **Starting the conversation.** A checklist the agent works through on a
  schedule — `personalTasks.enqueue({ runAt })` under the person's grant, which
  they can withdraw from their account page.
- **Artifacts.** A generated page rendered live, as `personalStorage` behind a
  route: per person by construction, and not the asset store, which belongs to
  the script and would serve one person's artifact to everyone.
- **Markdown, diffs and images** on the page.

## Designing the tools

The section above is _which_ tools. This is what the ones that have aged well
have in common, drawn from the
[MCP reference servers](https://modelcontextprotocol.io/examples) — fetch,
filesystem, git — which are deliberately boring and are the set nearly every
agent turns out to need. Worth reading before the tool list here grows.

**A few verbs over one noun.** Filesystem is five tools, not forty: one
resource, a closed verb set, names that do not need explaining. The servers
that age badly are the ones with a tool per API endpoint. `write_response`,
`remember`, `list_memories` and `recall` have this shape, and skills kept it —
one `read_skill` over a named folder, not a tool per skill, and not the two
that were planned once the index turned out to belong in the prompt.

**Tool count is a cost paid on every request.** Schemas sit in the prompt
whether or not they are used, and the model's accuracy in picking among them
falls off somewhere north of a few dozen. That is what deferred schemas are
for: load names, fetch a schema when a tool is actually wanted. The same
progressive disclosure as skills, which is not a coincidence — it is the one
trick that makes any large library affordable.

**The output shape is the real interface.** Fetch returns markdown rather than
HTML; browser automation returns the accessibility tree rather than pixels;
search returns `file:line` rather than file contents. Each of those was
somebody discovering that the smaller representation _also reasons better_,
because the part they dropped was never signal. It is a modelling decision
before it is a token-economy one.

**Errors are prompts.** A failure that says "no such key; these exist" turns a
dead turn into a recovered one, where a bare "not found" spends a step. Every
error string in `runTool` is free to write and is read by the model as
instruction.

**Return a handle when the payload is large.** An id or a path the model can
pass to the next tool, rather than bytes in the transcript. The engine already
does this where a read can save to a file and answer with its location.

**An edit beats a write.** A diff-shaped tool cuts output tokens by an order of
magnitude on anything large, which is why the engine grew `edit_asset` and
`edit_file` beside `write_file` rather than instead of it.

**Writes should be safe to retry.** `maxAttempts: 1` is right for a turn — a
retry is a second model call on somebody's own key — but it also means a tool
that half-applied leaves no second pass to finish it. Idempotent writes turn
that from a correctness problem into a policy choice.

## Prior art

Projects worth reading before building any of the above, ordered by how close
they are to this agent's actual problem — durable, multi-tenant, consent-gated,
and living inside a sandboxed runtime. [OpenClaw](https://www.digitalocean.com/resources/articles/what-is-openclaw) —
a self-hosted personal agent across many chat channels — proved the demand for
an agent that lives where the person already is, and its
[security findings](https://arxiv.org/pdf/2603.27517) are the permissiveness to
leave behind.

### Cloudflare Agents SDK, on Durable Objects

<https://developers.cloudflare.com/agents/>

The closest thing to what this already is, built by a platform team. One
durable actor per agent session, each with its own SQLite, hibernating when
idle and waking on demand, with scheduling and state sync to the browser built
into the session object rather than bolted beside it. Their 2026 additions
point straight at the budget problem this agent has: `keepAlive()` for work
measured in minutes, and fibers — `runFiber`, `stash`, `onFiberRecovered` — for
resuming after eviction.

Two things to take, and one of them has since arrived from the other
direction. The **per-session object is the lane queue**: isolation falls out
of the model rather than needing a claimed-status table beside it — the same
conclusion the engine reached in putting a lane on the queue rather than
leaving it to every caller. What remains to take is **state sync to the
client** — a state table the browser mirrors — a better shape than hand-rolled
activity rows, because the page stops being a second implementation of what
the run is doing.

### LangGraph: durable execution and the interrupt

<https://www.langchain.com/resources/ai-agent-frameworks>

Durable execution with checkpointers, `interrupt()` for human-in-the-loop, and
time travel — forking a run from any checkpoint. The turn chain here is a
hand-rolled subset of it.

The insight worth having is that **a checkpoint per step gives rewind, fork and
resume as one mechanism** rather than three features. And `interrupt()` covers
two separate items on this list at once: "cancel and interject" and "permission
modes" are both a run that suspends and waits for a person to answer. Building
them separately means building the same thing twice and having them disagree.

### SWE-agent and the agent-computer interface

The Princeton paper's thesis is that tool _ergonomics_ — the shape of a tool's
output, what its errors say, what it refuses — move results more than the
choice of model does.

This agent has five tools and is still about to grow a dozen. Read it before
that happens rather than after — the two that arrived since, `list_memories`
and `read_skill`, both ended up shaped by its argument about output: each
returns an index with a preview rather than the thing itself, and the follow-up
call is the model's to make.

### smolagents and CodeAct: code as the action

The idea is that the model writes code rather than emitting a JSON tool call,
and composition comes free — a loop, a condition, an intermediate value — where
a tool-call protocol needs a round trip per step.

**This is the one that fits here better than it fits anywhere else.** Every
other project adopting it has to build a sandbox first; aiwebengine _is_ a
sandboxed JavaScript runtime with a capability model already wrapped around
every global. A single `run_js` tool, with the engine's own sandbox as the
permission boundary, replaces a growing pile of hand-written tools and widens
what the model can express in one turn. Nobody else gets the hard half for
free.

This agent's `run_js` is this: `sandbox.run(modelWroteThis, { capabilities })`
— model-authored source, a named subset of what the script holds, and a
_result_ rather than a thrown error when the code does not work, so the error
feeds back to the model as the next observation. The README describes the
capability lists it runs under.

### OpenHands

<https://github.com/All-Hands-AI/OpenHands>

The most mature open-source coding agent. Its loop is an event stream — reason,
action, execution, observation — appended to a replayable log, with a pluggable
runtime behind it.

What to take is **the event log as the single source of truth**. This script
kept `messages` and `activities` as two tables written at different moments,
which can disagree about what happened in a run; one log with projections over
it cannot.

It is six tables — `messages`, `activities`, `runs`, `interjections`,
`plans`, `turn_usage` — and `app.js` reconstructs a run's state from the stream
as a seventh account of it. That makes this item, [state sync to the
client](#cloudflare-agents-sdk-on-durable-objects) and [session
management](#session-management) one piece of work rather than three: one log,
projections over it, and a page that mirrors rather than re-derives. Worth
doing before the list of surfaces grows again, since every new channel is
another place a divergence can show.

### Cline and Roo Code

The best-studied examples of _asking permission well_: a plan mode distinct
from an act mode, per-tool approval, and checkpoints that can be restored.
Worth copying when delegation scopes start gating individual tool calls rather
than the run as a whole.

### Aider

Two ideas. The **repo map** — a ranked summary of a large corpus, fitted to a
token budget — generalises well past code to any body of material an agent
needs an overview of. And **a commit per change**, which is the same instinct
`revisions.rs` already serves.

### TypeScript-native loops

The OpenAI Agents SDK for its handoffs, guardrails and sessions vocabulary;
Mastra for durable workflows; the Vercel AI SDK for streaming patterns, which
`fetchStream` makes applicable. Relevant mostly because this script is
TypeScript and the vocabulary transfers.

### The security reading

Not optional for this agent, because it has channels.

**Simon Willison on prompt injection, and the "lethal trifecta"** — private
data, untrusted content, and the ability to communicate externally. Any two are
survivable; all three together are not. This agent has all three — private
notes, anything `run_js` fetches or a channel delivers, and the network — which
is why [where `run_js` may send](#where-run_js-may-send) is the first item of
open work.

**CaMeL (DeepMind) and the dual-LLM pattern** are the defences that are
structural — a separation that holds regardless of what the untrusted text says
— rather than instructions asking a model not to fall for it.

### Sideways: Val Town

<https://val.town>

Not an agent project. The closest premise to aiwebengine as a _product_ —
server-side JavaScript that is live the moment it is written — so it is worth
reading for its developer-experience decisions rather than its agent ones.

### Leads, unverified

AgentScope Runtime (sandbox plus durable serving), and the 2026 entrants
DeepSeek Harness and TrueForge, appear in comparison roundups but have not been
looked at directly. Treat as leads rather than recommendations.
