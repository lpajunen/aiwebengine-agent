# Improvements

What this agent has today: a prompt box, an SSE activity log that fills in as
the model writes, four tools over responses and memory plus a fifth when the
deployment has skills, per-person keys, a durable turn chain with a step cap,
a cached prompt, a per-run cost display, and a stop button. What follows is
the rest of the surface a modern harness — Claude Code, Cursor, the chat UIs —
puts around that, grouped by layer, each with a note on what it costs here.

Most of it is still ahead. What has been built is marked **Built** where it
sits, with what it cost and what it turned out to need; the rest is a map and
not a decision.

## What the engine just landed

Five engine changes shipped since this file was first written, and between
them they clear the whole of what used to be the "engine, with no way round
it" list. Checked against `types/aiwebengine.d.ts`, refreshed alongside this
file.

- **A lane on the task queue.** `personalTasks.enqueue` takes a `lane` — what
  a task must not run beside — and **defaults it to the person**. This was the
  one correctness bug on this list, and deploying the new engine fixes it with
  no change to `main.ts`. (`docs/SCRIPT_TASKS.md`)
- **`fetchStream`.** Status and headers as they arrive, body in pieces,
  multi-byte characters reassembled across chunk boundaries, and iterable.
  Bridged to `routeRegistry.sendStreamMessage`, this is per-token output.
- **`fetchAll`.** Several requests inside one wall-clock window rather than
  sequenced — `Promise.all` over three fetches did not overlap them, because
  each had already finished by the time it returned. Not on this list when it
  was written; it is what makes a fan-out turn fit in one budget.
  (`docs/FETCH_CONCURRENCY.md`)
- **`sandbox.run`.** A script evaluating source under a named subset of its
  own capabilities — the single primitive that code-as-action and an enforced
  plan mode both wanted. (`docs/CAPABILITY_ATTENUATION.md`)
- **Delegation grew a verb and a way in.** `DelegationScope` carries `"write"`
  beside its two nouns, so a grant can say "may read, may not write"; and
  `personalTasks.enqueueFrom` starts a run as the person a message came
  _from_, resolved through a linked channel identity rather than an account a
  script names. (`docs/DELEGATION.md`)

So every row of the engine backlog table is gone, and the items parked behind
it — streaming, channels, enforced plan mode, code as the action — are script
work like everything else.

## What the first six were, and what they taught

The six items this file opened with are built. Each is described where it
belongs below; what follows is only what was surprising about them, because
in four of the six the obvious implementation was the wrong one.

1. **Prompt caching.** The obvious move — a breakpoint on the system prompt
   and the tool definitions — would never have fired once. `claude-haiku-4-5`
   has the highest minimum cacheable prefix of any current model at 4096
   tokens, and the static prefix is around 400; a prefix under the minimum is
   refused silently, with a `usage` reporting nothing cached. The breakpoint
   that pays is at the end of the conversation, and it covers the tools and
   system prompt anyway, because a breakpoint caches everything before it.
   Confirmed on a real run: `cached 0, wrote 0` on a 945-token prompt.
2. **Streaming.** The answer is not a text block. This agent speaks through a
   tool, so its text arrives as the `text` argument of a tool call — JSON, a
   fragment at a time — and waiting for that JSON to parse means waiting for
   the whole answer, which is the thing streaming exists to stop. Reading the
   half-written object is the feature.
3. **Skills as assets.** Built with one tool rather than the two proposed
   here: the model has to be told skills exist at all, and once the prompt is
   saying that much, naming them costs a line each and saves a round trip out
   of twelve. The index must be sorted, or it moves between turns and kills
   the caching from item 1 silently.
4. **`list_memories`.** As described, plus the same fix at the other end — a
   `recall` that misses now names the keys that exist, since guessing was the
   whole problem.
5. **Cancel and interject.** Two mechanisms, not one: the queued task is
   cancelled so a turn that has not started never does, and the run's state is
   written so a turn already in flight stops at the next boundary. An
   interjection is queued rather than appended, because text written into the
   conversation mid-turn sits before an assistant message that never saw it.
6. **Usage display.** `largestPrompt` is a max and not a sum — every turn
   resends the one before it, so adding prompt sizes measures nothing.

Two bugs surfaced on the way. `loadMessages` read its rows oldest-first under
a `LIMIT`, so a run past sixty rows was served its first sixty forever and
reasoned about a conversation that had stopped moving — silently, since
nothing failed. And a turn that answered in prose rather than through
`write_response` was filed as a note, so the answer arrived in the style
meant for the model talking to itself.

## Where to start next

1. **Compaction.** The ceiling `loadMessages` now enforces is a stop, not a
   solution, and it is the only thing standing between this and a long run.
   [Summarise and replace](#compaction) is one more kind of turn the queue can
   already run.
2. **Resuming a suspended run.** The half that stops one is built and every
   kind of stop goes through it; `RunState` already names `waiting`. What is
   missing is the half that resumes, which is
   [plan mode, permission prompts and approval all at once](#three-features-one-primitive).
3. **Skills the agent writes.** The authoring half shipped; the half worth
   having is [the agent writing its own](#skills-as-markdown-written-by-the-agent),
   and `revisions.rs` makes every one of them revertible.
4. **Memory the person can read.** `list_memories` made the notes readable by
   the model. [The person still cannot see them](#memory-the-person-can-read),
   and an agent that remembers things about somebody without showing them is
   one they cannot correct.
5. **Mounting the engine's own MCP tools** — `McpClient` is in the API and
   [the catch is a design question](#the-engine-is-already-an-mcp-server)
   rather than a wiring one.

## Where the work lands

All of this list is `main.ts` now. It was not when the file was written —
four items were blocked on the engine rather than merely helped by it, and two
of the more interesting ideas sat behind a primitive that did not exist. That
section is kept below as a record of what the engine grew and what each piece
was for, because the shape of a feature is easier to get right knowing which
constraint it was built against.

Checked against `types/aiwebengine.d.ts` rather than assumed.

### Script only

Which is now everything. Built so far: prompt caching, streaming, skills as
assets, `list_memories`, the usage display, and cancel and interject on a
`runs` table beside `personalTasks.cancel`.

Still ahead: slash commands, project instructions, compaction, attachments,
per-run model choice, the run list, mounting other MCP servers (`McpClient`
is in the API), the event-log consolidation, the channel adapters, and the
resuming half of the suspended run — plan and act, and per-tool approval.

Three that looked uncertain and are not:

- **`list_memories` needs nothing.** `Storage` exposes `length` and
  `key(index)`, so enumerating a person's notes works today.
- **The heartbeat needs nothing.** `personalTasks.enqueue({ runAt })` already
  schedules per-person work under the grant. No `schedulerService` change.
- **One run at a time per person needs nothing.** The queue defaults a personal
  task's lane to the person. A lane per _conversation_ rather than per person
  is a refinement, not the fix — and one the page would now notice, since it
  tracks a single run and would have to grow a notion of which.

### Built in the engine, unused from here

**Checkpoints over agent-written files.** `revisions.rs` wants using, not
writing.

**A reduced sub-context.** `sandbox.run` is installed and uncalled. See
[code as the action](#smolagents-and-codeact-code-as-the-action) and
[plan mode](#it-would-be-enforced-here-not-merely-offered) — one call
underneath both. It is also what
[a skill-writing tool](#skills-as-markdown-written-by-the-agent) will want,
since a turn that may write skills is a different turn from one that may not.

**A way for a message to start a run.** `personalTasks.enqueueFrom`,
`sender()` and `inviteLink()` are the channel half, built and unwired.

**`fetchAll`.** Used by nothing here. The turn loop makes one model call and
runs tools in sequence; a fan-out turn is what would want it.

### One primitive behind two of the best ideas

[Code as the action](#smolagents-and-codeact-code-as-the-action) and
[plan mode that is enforced rather than offered](#it-would-be-enforced-here-not-merely-offered)
look like separate items. They are one primitive: **a script asking the engine
to run something with fewer capabilities than the script itself holds.**

That is now `sandbox.run(source, { capabilities })`. It evaluates source in
this script's own sandbox holding only what the call names; `sandbox.held()`
is the set a narrowing subtracts from. It refuses a subset the caller does not
itself hold, refuses an unrecognised capability rather than dropping it, and
nests four deep against a budget shared with the turn that opened it.

The part that matters for both features is that it is a separate context
rather than a mask over the running one: the two share no object graph, so the
unrestricted parent cannot hand the restricted region a function and have it
called — a capability leak by reference that no mask catches. A filtered tool
list can be argued past. This cannot, because the check sits _under_ the
JavaScript rather than in it.

### The engine backlog, cleared

| Engine work                                                         | What it unblocks                                        | Shipped as                       |
| ------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| Streaming `fetch`, bridged to SSE                                   | Output per token rather than per turn                   | `fetchStream`                    |
| Capability attenuation — a reduced sub-context                      | Code as the action, enforced plan mode, untrusted input | `sandbox.run`                    |
| Delegation reach — scope verbs, and acting for a person off-request | Channels, async plan approval, narrowed background work | `"write"` scope, `enqueueFrom`   |
| A lane key on the task queue                                        | One run at a time per person                            | `lane`, defaulting to the person |

Everything on this list is `main.ts`.

## Context layer — how the model learns what it is for

### Project instructions

A file loaded into the system prompt on every run (`CLAUDE.md`, `.cursorrules`,
"custom instructions"), usually hierarchical: global, then project, then
directory.

Here: an asset for the deployment's own text and a `personalStorage` entry for
the person's, concatenated onto `SYSTEM_PROMPT`.

### Skills

A folder per skill: a `SKILL.md` carrying `name` and `description`, plus
whatever resource files it needs. Only the names and descriptions sit in
context; the model reads a body when it decides the skill applies.

**Progressive disclosure is the whole point.** Forty skills cost forty lines
until one of them is invoked, which is what makes a large library affordable at
all. A harness that pasted every skill into the system prompt would be a
harness with three skills.

**Built**, with one tool rather than two. `skills/<name>/SKILL.md`, a
description in front matter, and the folder name as the skill's name — the one
identifier that cannot disagree with itself, so a `SKILL.md` written for
another harness drops in unchanged.

`list_skills` was not built and the reason is worth keeping: the model has to
be told skills exist at all, so the system prompt is already saying that much,
and naming them there costs a line each and saves a round trip out of the
twelve a run gets. The index rides in the prompt; `read_skill` fetches a body,
and a file beside it when the SKILL.md points at one.

Two things fell out of prompt caching that would not have been obvious before
it existed. The index is **sorted**, because it sits at the front of the
cached prefix and an order taken from whatever the asset listing returned
would shift between turns and kill every cache hit — silently. And it is kept
in `scriptStorage` under a fingerprint of the skill files and their
modification times, because building it costs one asset read per skill per
turn, which is fine at three skills and not at forty. Affordable at forty is
the whole argument for progressive disclosure.

A deployment with no skills gets the system prompt it had before, byte for
byte, and is not offered the tool.

### Slash commands

Prompt templates the _person_ invokes, with argument substitution. Distinct
from skills, and the distinction is who chooses: a skill is something the model
reaches for, a slash command is something the person asks for by name.

Here: assets again, expanded by the page before it posts.

### Memory

Facts that survive a run, written with a description line and recalled by
relevance rather than by exact key.

`remember` and `recall` are the primitive. What was missing is the index:
`recall` needs a key the model already knows, so anything written in an
earlier run was unreachable unless it happened to guess the name.

**Built.** `list_memories` gives each key, the note's size and its first line.
The description is taken from the value rather than written at save time,
which needs no second argument and works on notes already stored — and a note
short enough to fit _is_ its own preview, so no `recall` follows. The size is
what tells the model the preview is the start of something longer.

The same fix at the other end: a `recall` that misses now names the keys that
exist. Guessing was the problem, and a step spent learning "not that one"
teaches nothing by itself.

Still opaque to the _person_, which is the half that matters most — see
[memory the person can read](#memory-the-person-can-read).

### Attachments and @-mentions

Pulling a file, a URL or an image into the conversation by reference rather
than by paste. `fetch` and `assetStorage` cover the first two; images need the
multimodal content-block form rather than text.

### Compaction

When the window fills, summarise the middle of the conversation and carry on,
rather than truncating it. A summarise-and-replace turn is the standard answer
and fits the existing shape — it is one more kind of turn the queue can run.

`MAX_HISTORY_ROWS` is a hard stop, and now genuinely is one: it used to be a
`LIMIT` on a read ordered oldest-first, so a run past sixty rows was served
its first sixty forever and went on reasoning about a conversation that had
stopped moving, without anything failing. A run that reaches the ceiling is
now stopped where it stands.

Stopping is not solving, and this is the item that decides how long a run can
be. The reason it cannot simply slide a window is worth writing down: a run
has exactly **one** genuine user message, the prompt, and every later one
carries `tool_result` blocks the API requires to be preceded by the matching
`tool_use` in the message immediately before. Dropping rows off the front
either starts the conversation on an assistant turn or orphans tool results.
There is no valid truncation point except the beginning — which is why the
answer has to be summarise-and-replace rather than a window.

### Prompt caching

`cache_control` breakpoints, so the part that did not change costs a fraction
of what it did the first time. Every turn here resends the run so far, which
is what makes the bill grow with the length of a run.

**Built** — and it was not six lines on the system prompt, which is what this
section used to say. That breakpoint would never have fired.
`claude-haiku-4-5` has the **highest minimum cacheable prefix of any current
model, 4096 tokens**, and the tools and system prompt come to roughly 400
between them; a prefix under the minimum is refused silently, with no error
and a `usage` that simply reports nothing cached.

The breakpoint that pays is the one at the end of the conversation — the
top-level form places it and moves it forward — and because a breakpoint
caches everything _before_ it, that single one covers the tools and the system
prompt too, once the whole prompt is large enough to qualify. What crosses
4096 tokens is a long run, which is exactly the one worth making cheaper.
Moving up a tier lowers the threshold (512 on Opus 5), so it starts paying
sooner there.

A real run confirmed the arithmetic: `cached 0, wrote 0` on a 945-token
prompt. Caching does nothing for short runs on this tier, by design and not by
accident.

The 5-minute TTL is deliberate: a turn is queued the moment the one before it
ends, so every turn refreshes the entry, and the 1-hour TTL would double the
write price to buy a gap this loop does not have.

Every turn logs what it spent, because a prefix that stops matching still
answers and is simply billed in full — nothing else announces that failure.

## Tool layer

- **MCP client.** Connecting to external tool servers and offering their tools
  to the model. `McpClient` is already in the engine's JavaScript API, so an
  agent could mount somebody's MCP server as extra tools at runtime.
- **Tool search, deferred schemas.** Past a few dozen tools, load names only
  and fetch a schema when a tool is actually wanted — the same progressive
  disclosure as skills, applied to tools.
- **Subagents.** An isolated context for a fan-out task, whose tool output
  never enters the parent's transcript — only its final report. `personalTasks`
  nested one level is most of this.
- **Background work.** Start something long, keep talking, be told when it
  finishes.
- **Hooks.** Deterministic code on lifecycle events — before a tool runs, after
  it returns, when a run stops. Guardrails the model cannot talk its way past,
  which is a different thing from instructions asking it not to.
- **Structured questions.** A typed "pick one of these" tool, rather than the
  model asking in prose and hoping the answer comes back parseable.

## Designing the tools

The section above is _which_ tools. This is what the ones that have aged well
have in common, drawn from the
[MCP reference servers](https://modelcontextprotocol.io/examples) — fetch,
filesystem, git — which are deliberately boring and are the set nearly every
agent turns out to need. Worth reading before the tool list here grows past
three.

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

### The engine is already an MCP server

Worth saying out loud, because it is built and unused from here.

The engine exposes `read_file`, `write_file`, `edit_file`, `search_files`,
`list_files`, `run_tests`, `check_script`, `eval_script` and `read_logs`,
alongside revisions, deployments and git sync. That is the filesystem
primitive, a test runner, a checker and a time machine — the whole loop a
coding agent needs, and `McpClient` is in the JavaScript API, so an agent here
could mount it.

An agent that can write a solution, check it, test it and revert it, with
`revisions.rs` underneath making every step undoable, is an unusually complete
story for how little of it would have to be written.

**The catch is a design question rather than a wiring one.** Those tools are
gated on ownership and on being an administrator, and `delegation.rs` caps
background work at `UserContext::authenticated` deliberately — so that a
delegated task is not the way to obtain a context that can author a solution.
The two cannot both hold. So this is not a delegated agent working while
somebody is away: it would have to run inside that person's own request, under
their own editor rights, with the tools scoped to the scripts they own.

Which is a narrower thing than the agent this already is, and the narrowness is
the point. Decide that before wiring anything.

## Run control — mostly what separates a demo from something usable

### Streaming

Tokens and visible reasoning as they arrive. **No longer blocked.**
`fetchStream(url, options)` hands back status and headers as soon as they
arrive and the body in pieces as it does, and the stream is iterable, so the
bridge is one loop: `for (const chunk of stream)
routeRegistry.sendStreamMessage("answer", chunk)`.

**Built**, and the hard part was not the SSE parsing.

**The answer is not a text block.** This agent speaks through a tool, so its
text arrives as the `text` argument of a `write_response` tool call: JSON, a
fragment at a time. Waiting for that JSON to parse means waiting for the whole
answer, which is the thing streaming exists to stop. So the half-written
object is read directly and only what has grown since last time is sent —
stopping wherever the text runs out, mid-escape included, since `\u00` is not
yet a character and guessing the rest puts the wrong one on somebody's screen.
A lone high surrogate is held back for the same reason.

Deltas go to the stream and nowhere else: the table stays the record, written
once by the tool that produced the text, so a page opened tomorrow reads what
it always did. One send per network read rather than one per delta — the
network has already done the coalescing and every send is a host call.

Three things a first attempt will hit, all stated in the type declaration. A
chunk is not a line and not an SSE event. No content coding is requested. And
an abandoned stream holds a socket until the execution ends, so `close()` what
you stop reading — in a `finally`, since closing one already finished is a
no-op and that covers the thrown path without a second branch.

Two failures that were previously invisible now say so: an `error` frame
arriving after a 200, and a body that ends before `message_stop` — which
`maxAttempts: 1` means nothing will retry, so a silent truncation would have
been stored as what the model said and replayed on every turn after it.

`fetchAll` is the neighbouring addition and is **not** used yet: several
requests inside one wall-clock window rather than sequenced. It matters for a
fan-out turn — three tool calls that each take a second cost three seconds of
a budget, not one, without it.

### Interruption and steering

**Built.** A run has a row now, which is the thing there was none of: a run
was only ever implied by the rows that mentioned its id, so there was no
object to cancel.

Cancel is two mechanisms because one is not enough. The queued task is
cancelled so a turn that has not started never does; the run's state is
written so a turn already in flight stops at the next gate. Cancelling the
task alone leaves a running turn free to queue its own successor; writing the
state alone leaves a pending task to wake up, read it and burn an execution
slot doing nothing.

An interjection is **queued, not appended**, and that is the part worth
keeping. The turn in flight has already read the history, so text written into
the conversation now would sit before an assistant message that never saw it,
and the turn after would read that as an aside already answered. It is
delivered at the top of a turn — the only point where "the model has not
decided anything yet" is true.

The one real race is a cancel landing during a model call, which cannot be
interrupted. The state write takes the state the caller believes the run is in
and skips otherwise, so a turn finishing normally cannot overwrite a cancel
that arrived while it worked.

The advice above was right and was followed: the stopping half is written once
and every kind of stop goes through it. See
[the suspended run](#three-features-one-primitive) for what is left.

### Permission modes

Per-tool approval, allowlists, and a read-only mode where the agent proposes
before it touches anything. The delegation grant is the half that says what the
agent may ever do; the run-side half is a paused state the page can answer.

Both are treated under [plan mode and act mode](#plan-mode-and-act-mode).

### Plan mode and act mode

A read-only mode in which the agent proposes, and an acting mode it enters once
a person has agreed. Claude Code, Cline and Cursor all ship some form of it.

It is worth being clear that planning is not really what it is for. It is three
things at once: a gate on the asymmetry between a wrong read, which costs a
token, and a wrong write, which costs a rollback; a cheap place to correct a
misunderstood _premise_ before a long run spends money on it; and an answer to
approval fatigue, since per-tool prompts teach people to click yes and one plan
replaces forty of them.

**Today the distinction is still nearly vacuous here.** This agent's tools are
`write_response`, `remember`, `list_memories`, `recall` and `read_skill` —
nothing writes anything outside the person's own notes, so it is already
close to permanently in plan mode and there is little for an act mode to
unlock. `remember` is the one write, and a plan mode that only gated that
would be theatre. It becomes load-bearing at three moments
already on this list: when MCP tools mount, when
[the engine's own tools](#the-engine-is-already-an-mcp-server) are among them,
and when the first channel adapter arrives.

#### It would be enforced here, not merely offered

Every harness named above implements this as a filtered tool list plus an
honour-system prompt. The loop offers fewer tools and trusts itself. None of
them can actually enforce read-only — a model that finds a write path through a
tool that looked read-only simply takes it.

This engine can, because capabilities are checked at the sandbox boundary
rather than inside the agent loop. Plan mode here is a turn run under a
`UserContext` holding the read capabilities and none of the writing ones, and
the model cannot argue its way past that, because the enforcement is _under_
the JavaScript rather than in it.

It is the same argument this file already makes about OpenClaw — the constraint
belongs in the substrate — and this is the second place it pays.

The condition that used to be attached is met. `sandbox.run` runs source
under a named subset of what this script holds, so a planning turn is that
call with the writes left out — `sandbox.held()` filtered — and the model
cannot find a write path through a tool that merely looked read-only, because
the context it is running in has no write capability to find.

One shape it imposes is worth knowing before building it: what gets narrowed
is a _string of source_, not the surrounding turn, and the two contexts pass
nothing but JSON. So the tool-dispatch half of a planning turn has to run
inside the sub-execution. That is a constraint if the tools stay hand-written
and it is free if they do not — which is the argument for reading
[code as the action](#smolagents-and-codeact-code-as-the-action) alongside
this section rather than after it. It is the
[same primitive](#one-primitive-behind-two-of-the-best-ideas), and it now
exists.

#### It collides with the premise, and the collision is informative

Plan mode assumes somebody is watching. The point of this agent is that the run
outlives the tab, so a plan awaiting approval blocks on the person coming back,
which for delegated work may be hours.

The reframe that settles it: **a delegation grant already is a plan approved in
advance.** Naming scopes, with an expiry, before any run starts is the
asynchronous form of approving a plan mid-run. The async half is built. The
interactive half is not, and the two suit different runs, so both should exist:
a run with the person present proposes and waits, a run with them away treats
the grant as the approval and its scopes as the ceiling.

The vocabulary the second needed has arrived. `DelegationScope` was two
nouns, `personal_storage` and `secrets`, naming _what_ a delegation reaches
and nothing naming what it may do with it — so every grant was a grant to
change as well as to read. It now carries `"write"` beside them, and a grant
without it resolves to a context holding the reads and none of the writes,
refused at the same gate every other caller meets rather than by the loop
asking itself nicely.

Worth knowing when designing against it: reading is the floor rather than a
scope, since a delegation that could not read would have nothing to act on.
What `"write"` adds is storage writes, script-data writes, enqueueing and
sending — so a read-only delegation cannot chain tasks, and therefore cannot
be a long one. That is a real design constraint on an async plan-approval
flow, not an incidental one.

#### Three features, one primitive

In a queued-turn architecture, plan → act needs a run that **suspends,
persists, and resumes on a human answer**:

- an `exit_plan` tool that ends the chain _without_ enqueuing the next turn
- a plan row the page renders with approve and reject
- approval flipping the run's mode and enqueuing the next turn

That is the same machinery as [cancel and
interject](#interruption-and-steering), and the same as per-tool approval, and
the same as LangGraph's
[`interrupt()`](#langgraph-durable-execution-and-the-interrupt). One primitive
wearing three names. Built separately they end up disagreeing about what a
suspended run is.

**Half built, on purpose.** Cancel and interject needed the stopping half, so
it was written once and every kind of stop goes through it: a run has a state
and `advanceRun` proceeds only from `running`. `RunState` already names
`waiting` — a run suspended for an answer only a person can give — and nothing
sets it.

So what is left is genuinely only the resuming half, and it is the same three
pieces this section already lists: a tool that ends the chain without
enqueuing the next turn, a row the page renders with approve and reject, and
approval enqueuing the turn. Nothing has to be unpicked first, which was the
point of not building them apart.

#### Where it pays off most

The channel warning. A message from a stranger is agent input, and the defence
is not a new mechanism but a mode: **a run from an unknown sender stays
read-only, and only the account owner's own prompt can promote one to act.**
Plan mode and the prompt-injection defence turn out to be the same lever, which
is the strongest argument for building it before the adapters rather than
after.

Both halves of that lever now exist, which turns this from an argument into a
task — and the ordering advice still holds, because the adapters are now
buildable in an afternoon. An unknown sender already resolves to nobody, since
`enqueueFrom` refuses rather than guessing, so the live question is what a
_linked_ sender's message may do. The grant's scopes answer the standing half:
a person who granted read and not `"write"` has already said. `sandbox.run`
answers the per-run half, for when the same person's own prompt should act and
a message they forwarded should not.

#### One caution

Two modes is the floor. Harnesses drift to three or four — plan, auto-accept,
unattended — because the thing that actually varies is _how often a person is
asked_, and that is a scalar rather than a toggle. Designing it as one from the
start avoids re-litigating it every time a tool is added.

### Checkpoints and rewind

Undoing a turn together with its side effects. `revisions.rs` is already this
shape, for an agent that writes files.

### Session management

Resuming, listing past runs, forking from a turn, sharing a transcript. The
rows are per run already; the page shows one run and no way back to the others.

### Cost and token accounting

Per-run spend and a context-window meter. Each person pays with their own key,
so the bill is theirs to see.

**Built.** Turns, tokens in and out, how much of the input came from cache, an
estimate in dollars, and a meter for the largest prompt against the context
window.

`largestPrompt` is a **max and not a sum**, and it is the one number here that
would have been quietly wrong the other way: every turn resends the turn
before it, so adding prompt sizes measures nothing and the meter would climb
past the window on an ordinary run.

One row per turn rather than a running total updated in place — appending
cannot lose an earlier turn to a read-modify-write. The stream carries a delta
and the page holds the total it loaded with its history, so a message that
never arrives is corrected by the next reload rather than being wrong forever.

Prices live next to `MODEL` and move with it. A price list is the constant
that rots silently: the wrong number still renders and still looks
authoritative, to somebody spending their own money. The four rates are kept
apart rather than averaged, since caching is most of what a run costs or
saves, and the page is sent the rates rather than keeping a copy.

Not built: a lifetime total. It needs aggregation the query API does not do,
and summing every row a heavy user has on each page load is the wrong shape.

### Model and effort

Tier, thinking budget and output ceiling as per-run choices rather than
constants. Note what the comment above `MODEL` says: moving a tier is three
changes, not one.

## Presentation

Markdown and syntax-highlighted code, diff views, images in and out, citations,
and **artifacts** — a panel where a generated page or document renders live
instead of scrolling past as text.

The artifact equivalent is unusually natural here, because the engine is a web
server: a tool that writes an asset and returns its URL is most of it.

## Ideas worth stealing from OpenClaw

[OpenClaw](https://www.digitalocean.com/resources/articles/what-is-openclaw)
— shipped as Clawdbot, briefly Moltbot — is a personal agent you run yourself,
and what it demonstrated is not a modelling idea but a distribution one. It is
worth reading against this agent because the two projects made opposite bets:
it maximised what an agent could reach and paid for that in
[security findings](https://arxiv.org/pdf/2603.27517), while this one is built
on an engine whose whole premise is the constraint.

The demand it proved is real. The permissiveness it proved is the part to leave
behind.

### The agent lives where the person already is

Ten or more channel adapters — WhatsApp, Telegram, iMessage, Discord, Slack,
email — normalised into one gateway. Nobody visits a chat page; they message
their assistant from wherever they already were. That one decision is most of
why the project spread, and none of it is about the model.

This agent has exactly one channel, the `/agent` page. The shape of the
addition is a webhook route per channel, normalised to the inbound form
`startRun` already accepts: `messages` gains a `channel` column, and
`write_response` delivers to wherever the run came from rather than to the SSE
stream alone.

**It is script work now.** A webhook still arrives with nobody signed in, and
a script still cannot name an account — anyone able to reach the webhook could
then start anybody's agent. What the engine grew instead is a resolution step.
`personalTasks.enqueueFrom({ channel, identity, ... })` names a _sender_ as
that channel names them, and the engine maps it onto whoever linked it, under
that person's existing grant. An unlinked sender resolves to nobody, so a
handler that trusts the wrong field in a body can be made to claim the wrong
sender — not to name a different account or enumerate one.

The linking is a consent flow rather than a URL. `personalTasks.inviteLink()`
mints a single-use token the bot replies with **into that sender's own chat**,
because being able to read that sender's messages is the only evidence of
ownership the engine can have — a link that named the sender would be one
anybody could construct for anybody, and linking somebody else's id first does
not merely squat on it, it intercepts every message they send.
`personalTasks.sender()` answers whether a sender is linked and whether their
grant is live, so an unknown sender gets the link rather than a run; it
deliberately never answers with the account id, which would end up in whatever
the bot logs or echoes back into the chat.

So the first adapter is: a webhook route, a signature check, `sender()`, and
either `enqueueFrom` or a reply carrying `inviteLink()`. The signature check is
the script's job and the engine's documentation says so rather than pretending
otherwise — Telegram and Slack sign their webhooks, email does not, and the
engine cannot verify that the message came from the sender it claims.

The discipline that makes it work is the normalisation: platform specifics
travel as metadata and never reach the reasoning loop. An agent that knows
which of its ten channels it is on is an agent with ten variants of every
prompt.

Read [the warning below](#what-follows-a-channel) before building the first one.

### A serial queue per session

Every session gets its own queue and runs one task at a time, keyed
`workspace:channel:userId`.

This named a bug here rather than a feature, and the engine has since fixed
it. `personalTasks.enqueue` takes a `lane` — at most one task per lane runs at
a time — and it **defaults to the person**, on the reasoning that every
solution queueing per-person work had the same bug and the queue is a better
place to hold the invariant than each of its callers. Two prompts from one
person no longer interleave, and the `runs` table this section proposed is not
needed for it.

What is left is a choice rather than a fix. `lane` takes a name, so one lane
per _conversation_ rather than per person is a one-line change if somebody
should be able to run two threads at once; `lane: null` opts out entirely.
`scriptTasks` defaults to no lane, since a script task belongs to the solution
and defaulting it would serialise the whole queue — worth knowing if this
agent ever queues work that is not per-person.

### Skills as markdown, written by the agent

Skills are YAML-fronted markdown rather than plugins: anyone can author one, no
code, hot-reloaded, and the agent can write its own.

The authoring half is [built](#skills). The half worth adding is the agent
writing them — and that is where this engine is better placed than OpenClaw
is, because `revisions.rs` makes a skill the agent wrote versioned and
revertible. A self-modifying agent with no undo is a different proposition
from one where every edit is a revision somebody can diff and roll back.

The shape is now small: a `write_skill` tool over `assetStorage.upsertAsset`
at `skills/<name>/SKILL.md`. Two things to decide first. The index is cached
under a fingerprint of the skill files, so a skill written mid-run changes
what the _next_ turn is told it has — correct, but worth knowing. And a script
writing its own assets needs the capability to do it, which is the question
[`sandbox.run`](#one-primitive-behind-two-of-the-best-ideas) exists to answer:
a turn that may write skills is a different turn from one that may not.

### Memory the person can read

Memory as plain Markdown, YAML and JSONL in a workspace folder: gittable,
hand-editable, auditable at a glance. Not an opaque store.

`remember` and `recall` are opaque key-value rows. Making them listable,
visible on the page and editable by the person is a small change, and the
transparency _is_ the feature — an agent that remembers things about somebody
without showing them what it remembers is one they cannot correct.

Listable is [done](#memory). Visible and editable are not, and they are the
two that this section is actually about: `list_memories` made the notes
readable by _the model_, which is not the same thing at all. What is missing
is an endpoint and a panel — and, once a person can see a note, somewhere to
delete one, which no tool currently offers either.

### It starts the conversation

A "heartbeat checklist" — a markdown file of things to look at — lets the agent
open a conversation rather than only answering one: the inbox, the calendar, a
deadline it was told about. Almost every chat interface is strictly
request-response; this is the feature that makes an assistant feel like one.

`schedulerService` and `personalTasks` are the substrate, and this agent is
better founded for it than OpenClaw is: a delegation grant is a recorded,
scoped, expiring statement that this script may act as a person while they are
away, which they can withdraw from their account page. OpenClaw simply acts.

### What follows a channel

The security analysis of OpenClaw names its root cause as prioritising what an
agent could reach over what it should, and it observes that retrofitting the
constraint is far harder than starting with it. Its vulnerability classes read
almost as an inverted list of what this engine already does differently: no
granular permission model against capability-based authorisation; unsandboxed
tool execution against a QuickJS context per execution; plaintext credentials
against `user_secrets` encrypted at rest and unreadable from JavaScript;
origin-validation failures against the CORS, CSP and trusted-proxy handling.

One of its problems does not stay behind, though, and it arrives with the
channels: **an inbound message from a stranger is agent input.** Prompt
injection through an untrusted channel is the headline finding, and adding an
adapter is what creates the exposure.

Design for it before the first adapter rather than after the third. The
instrument is already here: a message from an unknown contact should resolve to
a narrower delegation scope than the same words typed by the account owner on
their own page. Two scopes and a rule about which applies is cheap now. It is
expensive once three channels exist and all of them assume the wide one.

## Prior art

Projects worth reading before building any of the above, ordered by how close
they are to this agent's actual problem — durable, multi-tenant, consent-gated,
and living inside a sandboxed runtime. [OpenClaw](#ideas-worth-stealing-from-openclaw)
is the one treated at length above; these are the rest.

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

And the half that was missing is missing no longer. `run_js` is
`sandbox.run(modelWroteThis, { capabilities })` — model-authored source, a
named subset of what this script holds, and a _result_ rather than a thrown
error when the code does not work. The engine distinguishes "the request was
wrong" from "the code was wrong" deliberately, because the second is the
outcome of a turn rather than a failure of the loop running it, which is
exactly the distinction a CodeAct loop needs in order to feed an error back to
the model as the next observation.

It is a bigger decision than anything else on this list, and it deserves to be
considered as an alternative to expanding the tool list rather than as an
addition to it. It is now a decision rather than a wish.

### OpenHands

<https://github.com/All-Hands-AI/OpenHands>

The most mature open-source coding agent. Its loop is an event stream — reason,
action, execution, observation — appended to a replayable log, with a pluggable
runtime behind it.

What to take is **the event log as the single source of truth**. This script
keeps `messages` and `activities` as two tables written at different moments,
which can disagree about what happened in a run; one log with projections over
it cannot.

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
Mastra for durable workflows; the Vercel AI SDK for streaming patterns — the
caveat that used to hang on that last one is gone, since `fetchStream` is
precisely what the engine was missing. Relevant mostly because this script is
TypeScript and the vocabulary transfers.

### The security reading

Not optional for this agent, and the reason is the channels idea above.

**Simon Willison on prompt injection, and the "lethal trifecta"** — private
data, untrusted content, and the ability to communicate externally. Any two are
survivable; all three together are not. This agent already has the first and
the third. **Adding a channel adds the second**, and that is the whole of the
warning filed under [what follows a channel](#what-follows-a-channel), stated
more precisely than it is stated there.

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
