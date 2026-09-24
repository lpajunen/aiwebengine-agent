# Improvements

What this agent has today: a prompt box, an SSE activity log that fills in as
the model writes, a Telegram bot answering out of the same run, five tools —
`write_response`, `remember`, `list_memories`, `recall` and `run_js` — plus up
to three more that appear when a run is planning or the deployment has skills,
per-person keys, a durable turn chain that folds itself into a summary rather
than filling up, plan and act modes enforced under the JavaScript, a cached
prompt, a per-run cost display, and a stop button.

What follows is the rest of the surface a modern harness — Claude Code,
Cursor, the chat UIs — puts around that, grouped by layer, each with a note on
what it costs here.

**How to read this file.** The status tables below are the only place that says
what is built. Everything after them is design notes: what an item is for, what
it cost, and what it turned out to need. Several of those sections were written
before the thing they describe existed and still read as plans — where one
disagrees with the tables, the tables are what to believe. Status used to be
restated in five places, and six of those statements had drifted out of date
within a day of the work landing; one ledger is the fix.

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

The engine's own half has its own table, under
[the engine backlog](#the-engine-backlog).

### Gaps this file has no section for

Four things that belong on this list and have never had one written.

- **A regression suite.** 77 cases over five modules — see
  [the first suite](#the-first-suite). Two of the three most expensive bugs on
  this page now have a case named after them: the oldest-first `LIMIT` (as the
  ceiling-and-read pair) and the prompt sizes that were summed when every turn
  resends the one before. The third, an agent saying it had saved a note it
  had not, is covered at its decode layer and not at its effects.
- **Spend on a channel.** "Each person pays with their own key, so the bill is
  theirs to see" is true on the page and false everywhere else.
- **Approval provenance.** An approval can only carry out what the _approver's_
  context may hold — which is why a skill approved from Telegram is refused.
  That is a general rule and will bind every deferred action after this one.
- **Refreshing `types/aiwebengine.d.ts`.** Done, and the premise was wrong in
  a way worth keeping. The snapshot was not stale: it was byte-identical to
  the engine's own `assets/aiwebengine.d.ts`. What was stale was that file —
  it still said "A URL is never substituted", which the Telegram adapter
  depends on no longer being true. So the fix was in the engine, and the
  refresh here was a copy of the corrected file. **A snapshot can only be as
  current as the thing it snapshots**, and diffing the two says nothing about
  whether either matches the code.

## Where to start next

1. **The suite against a real deployment.** 77 cases have run under a
   stand-in for `test`, `describe` and `expect`; none has run under
   `run_tests`. Until one has, this suite is checked against what
   `aiwebengine.d.ts` says the matchers do.
2. **The parts that are not pure**, which is everything left worth covering:
   the state machine in `setRunState`, the ordering in `decide`, the swap in
   `compactRun`. Each needs a fake of something, which is a bigger step than
   any taken so far.
3. Then a second channel (Slack, which needs no engine change) or the run list.

Two items came off this list. The egress question was one: the half a script
can answer is answered — `run_js` holds no `read_storage` — and the other half
is engine work this repository cannot do. Refreshing the type snapshot was the
other, and it was already in sync; what needed fixing was the engine's own
copy. Both are described below.

### The egress question

[What follows a channel](#what-follows-a-channel) files prompt injection as a
thing to design for _before_ the first adapter. It was written when there was
no adapter, and it was out of date in the direction that matters: all three
legs of the lethal trifecta were already here.

`PLAN_CAPABILITIES` was `view_logs`, `use_network`, `read_assets`,
`read_storage`. So one `run_js` call, **in plan mode, with nothing approved**,
could read the person's notes and POST them anywhere. Untrusted content
arrives through anything that call fetches, and now through a chat as well.

The defence this file proposed — a run from an unknown sender stays read-only
— did not touch it, because **exfiltration needs no write capability**. That
is not a flaw in plan mode; it is that `use_network` has no destination
dimension. `Capability` names the verb and `FetchOptions` has no allowlist, so
"may call the network" means "may call anything".

**The script half is done.** `read_storage` is out of `PLAN_CAPABILITIES`, and
so out of `ACT_CAPABILITIES`, which concatenates it. `capabilitiesFor` drops it
from any list that also holds `use_network`, so a later widening cannot put the
pair back by accident: the lists are written so that the check never fires, and
it is there because the next person to edit them will be adding a name for a
good reason with a comment in front of them, and a comment is not a check.

What that buys, stated no higher than it is. Code can no longer walk the store
by itself, so a note reaches a URL only if the **model** carries it there
through the transcript, in text that is sitting in the activity log. That is
the boundary [CaMeL and the dual-LLM pattern](#the-security-reading)
formalise, and it is the most a script can draw on its own. It narrows the
data path; it does not close it. A model talked into pasting a note into a
`fetch` still pastes it.

Three things it cost, two of them small and one of them a surprise.

- Notes reach code as a literal now: `recall` or `list_memories` first, then
  the value passed into `source`. A turn, not a capability.
- Read-modify-write inside one execution is gone, in `act` as well as in
  `plan`, because `write_storage` now arrives without its pair.
  `personalStorage.length` and `key(i)` refuse in an approved run, which is
  what `list_memories` is for.
- **`read_storage` covered `scriptStorage` too**, which is the part nobody had
  counted. The Telegram webhook's shared secret lives there and has to,
  because checking it means _comparing_ it and the engine never returns a
  secret's value to JavaScript. So for as long as `run_js` held
  `read_storage`, that constant was three lines of model-authored code away
  from anywhere. What it is worth is bounded — forged messages from a sender
  who already trusts the bot, since `enqueueFrom` still refuses an unlinked
  one — which is why it was survivable, not why it was acceptable. The general
  shape is worth keeping: **a secret in a readable store is worth whatever the
  most permissive reader of that store can do**, and a tool that runs
  model-written code is the most permissive reader there is.

**The engine half has landed.** `sandbox.run(source, { capabilities, hosts })`
bounds where a sub-execution may go as well as what it may do, which is the fix
that holds regardless of what the untrusted text says: it takes away the
destination rather than the data. Every redirect hop is checked, not only the
URL the code wrote — an allowlist checked once is one open redirector away from
being none — and `McpClient` is bounded by it too.

**What is left is script work here, and it is a real decision rather than a
line.** `run_js` has to name the hosts a run may reach, and the list is the
whole of the value: too wide and it buys nothing, too narrow and the model
cannot do what it was asked. The shape that probably fits is the API this agent
already talks to plus whatever the person's own prompt named, with the default
being the model provider alone — but that is a judgement about what this
solution is for, not something to copy from the engine.

Until that list exists, the standing rule for anything added to
`PLAN_CAPABILITIES` still holds and is still what the guard encodes: **nothing
that reads private data goes into the same execution as `use_network`.** The
host bound makes that rule cheaper to relax later; it does not relax it by
itself.

### The first suite

34 cases over two modules, and the interesting part is not the cases.

**A root script cannot `export`.** The module loader refuses it outright —
"Root scripts cannot use export syntax; define global handlers instead" — and
a test module reaches its subject by importing it. So every line of a 4,800-line
`main.ts` was unreachable by a test, and no amount of test-writing discipline
would have changed that. The suite began with a split, because it had to:

- `agent/protocol.ts` — reading what the model sent. `frameData`,
  `jsonStringPrefix`, `unescapeOne`, `readErrorMessage`, `proseKindFor`.
- `agent/capabilities.ts` — `PLAN_CAPABILITIES`, `ACT_CAPABILITIES`,
  `wantedCapabilities`, `withoutTheExfiltrationPair`.

Those two first because they are where a mistake is _silent_. A half-decoded
`\u00` is a wrong character on somebody's screen, not an exception; an answer
misfiled as a note arrives in the voice the model uses talking to itself; and
a capability list is prose until something reads it. Every bug this file
records was found by a person reading a database or a log, which is the same
property from the other side.

**Nothing of a type crosses a module boundary.** The loader has no
`import type`, and it rewrites every import into a `const` bound to a
property — so importing a type compiles to a `const` bound to nothing. That is
why `wantedCapabilities` takes a `string` rather than a `RunMode`, and why
`proseKindFor` names the three fields it reads instead of taking a
`ContentBlock`. Both turned out better than the versions that would have
needed the type: a mode this script has never heard of now falls to the floor
rather than throwing, which is a case the suite pins.

**The second pass took the three that were named next**, and `main.ts` is
4,489 lines from 4,802.

- `agent/budget.ts` — what a run has spent and when it has had enough.
  `MAX_HISTORY_ROWS`, `HISTORY_QUERY_LIMIT`, the compaction thresholds,
  `spendOf`, `stepsFrom`.
- `agent/skills.ts` — the SKILL.md format, written and read.
- `agent/plans.ts` — decoding what an approval carries.

Three things the second pass turned up that the first did not.

**A constant is a better place for an invariant than a call site.** The
oldest-first bug was a `LIMIT` and a comparison that had to agree, written
three hundred lines apart. `HISTORY_QUERY_LIMIT = MAX_HISTORY_ROWS + 1` is
now one line with the reason attached, and a case asserts the pair rather than
either half. The extra row is the entire mechanism for telling "at the limit"
from "past it", and nothing about reading the code made that visible.

**The valuable case was the round trip, not either side of it.** `write_skill`
renders a SKILL.md and a later run parses it back — a writer and a reader for
a format nothing else validates, a hundred lines apart in one file. Testing
either alone proves nothing; `skills.test.ts` asserts that what
`renderSkillFile` writes is what `frontMatterValue` and `skillBody` read,
including a body that contains `---` itself, which markdown bodies do.

**Extracting the decode layer is most of the value of testing an effect.**
`performApproved` is a database write and a storage write, so it is not pure
and its test would need fakes. What made it worth extracting anyway is that
every one of its failures answers `null`, and the caller reports `null` as
"there was nothing to do" — which is correct, and is indistinguishable from
success to the person reading the chat. That is the same silence as the bug
the approval mechanism exists to fix. `rememberArgs` and `skillWriteArgs` are
that layer, and the cases are mostly about which inputs must not quietly
become nothing.

## The engine underneath

Six engine changes have shipped since this file was first written. Between
them they cleared the whole of what was once the "engine, with no way round it"
list — and two new rows have opened since, both found by building against it.

- **A lane on the task queue.** `personalTasks.enqueue` takes a `lane` — what
  a task must not run beside — and **defaults it to the person**. This was the
  one correctness bug on this list, and deploying the new engine fixed it with
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
- **A secret may fill in a URL path.** Added for Telegram, whose Bot API takes
  its token as a path segment and offers no header form. The template goes on
  carrying the scheme and host, so every check still runs against a string with
  no credential in it, and every line that writes the URL down writes the
  template. An engine older than this change cannot run the adapter at all.
- **An asset written from JavaScript records a revision.** `upsertAsset` wrote
  the asset and stopped, so a skill the agent wrote had no history, could not be
  reverted, and did not move a git binding off `in_sync` — which is how the
  first one got deleted by a pull for not being in the repository, with nothing
  anywhere recording that it had existed. This is what unblocks
  [checkpoints and rewind](#checkpoints-and-rewind).
- **`McpClient` is gated on `use_network` and `read_secrets`.** It was installed
  into every execution with no capability check, which made it the way around
  `sandbox.run` — see
  [the engine is already an MCP server](#the-engine-is-already-an-mcp-server).
- **`use_network` can be narrowed to a set of hosts.**
  `sandbox.run(source, { capabilities, hosts })`, checked on every redirect hop
  and on `McpClient` as well. This is the top row of the backlog, and the answer
  to [the egress question](#the-egress-question) that a capability set could not
  give. Picking the list is script work and is the part still to do.
- **`fetch` can return a body that is not text.**
  `fetch(url, { binary: true }).bodyBase64`, which unblocks a photo from a
  channel — the one attachment case that had no path.
- **Long-running MCP calls have a shape.** `mcp.task({ handler, payload })`
  hands the caller a task handle and moves the work to the durable queue; the
  client polls `tasks/get`. Relevant here in one place and not obviously:
  [background work](#tool-layer) — "start something long, keep talking, be told
  when it finishes" — is this, if the thing waiting is an MCP client rather than
  this agent's own page. It does nothing for the page, which has the SSE stream
  already.
- **The engine serves MCP resources.** `mcpRegistry.registerResource(uri,
assetName, metadata)` publishes one of a script's own assets under a URI, and
  it is asset-backed rather than handler-backed on purpose. Two things here
  might want it: the [artifacts](#presentation) item, if an artifact should be
  readable by a client and not only by a browser, and an image — a resource
  answers non-UTF-8 content as base64, so **an image is reachable over MCP even
  though `FetchResponse.body` is still a string**. It does not solve the photo
  case, which is inbound, but it is the first place binary content crosses this
  boundary at all.

### The engine backlog

| Engine work                                                         | What it unblocks                                        | State                            |
| ------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| Streaming `fetch`, bridged to SSE                                   | Output per token rather than per turn                   | `fetchStream`                    |
| Capability attenuation — a reduced sub-context                      | Code as the action, enforced plan mode, untrusted input | `sandbox.run`                    |
| Delegation reach — scope verbs, and acting for a person off-request | Channels, async plan approval, narrowed background work | `"write"` scope, `enqueueFrom`   |
| A lane key on the task queue                                        | One run at a time per person                            | `lane`, defaulting to the person |
| A secret in a URL path                                              | Any API that takes its token as a path segment          | `resolve_url`                    |
| `use_network` narrowed to a host allowlist                          | The one structural answer to exfiltration               | `sandbox.run(…, { hosts })`      |
| A binary response body                                              | An image from a channel, or from anywhere but an upload | `fetch(url, { binary: true })`   |

The second of those is worth stating precisely. `FetchResponse.body` is a
string — `String::from_utf8` on the bytes, which _errors_ rather than
substituting — so a photo a person sends the bot cannot be retrieved at all. An
image _uploaded to the page_ needs nothing: `request.files[].data` is already
base64, which is the content-block form. And an image named by URL needs nothing
either, since the API will fetch a URL source itself. It is only the middle case
that is blocked.

**Built, and it was the small thing it looked like once the engine was read
rather than guessed at.** `fetch(url, { binary: true })` answers with the bytes
as base64 in `bodyBase64`, and `body` is empty — exactly one of the two carries
the answer, so there is never a question of which to read.

Three decisions in it are worth knowing before using it. It is an **option**
rather than a field every response grows, because base64 is a third again the
size and every JSON call would have paid for it. It is not a **silent
fallback**: without the option a non-text body is still refused, because a
binary body answering as an empty string reads exactly like a server that sent
nothing — what changed is that the refusal now names the option that fixes it.
And the engine decides nothing from the `Content-Type`, which is a claim; the
caller says what it expects.

So the photo case is unblocked: `fetch(fileUrl, { binary: true }).bodyBase64`
is already the content-block form, which is what `request.files[].data` gives
for an upload. The three cases in
[attachments and @-mentions](#attachments-and--mentions) are now all open.

### Three that looked uncertain and are not

- **`list_memories` needs nothing.** `Storage` exposes `length` and
  `key(index)`, so enumerating a person's notes works today.
- **The heartbeat needs nothing.** `personalTasks.enqueue({ runAt })` already
  schedules per-person work under the grant. No `schedulerService` change.
- **One run at a time per person needs nothing.** The queue defaults a personal
  task's lane to the person. A lane per _conversation_ is the open question
  now, not a refinement: with a chat and a page both live, one lane per person
  holds a message behind whatever the browser is doing.

### Built in the engine, still unused from here

**Checkpoints over agent-written files.** `revisions.rs` wants using, not
writing — and `write_skill` is what finally gives it something to version.

**A second narrowing.** `sandbox.run` is called by `run_js` and by nothing
else. What is still unused is a _planning_ turn holding fewer capabilities than
`run_js` already holds.

**`fetchAll`.** Unused by the turn loop, which makes one model call and runs
tools in sequence. It is advertised to the model in the `run_js` description,
so model-written code can reach it; nothing this script wrote does.

### One primitive behind two of the best ideas

[Code as the action](#smolagents-and-codeact-code-as-the-action) and
[plan mode that is enforced rather than offered](#it-would-be-enforced-here-not-merely-offered)
look like separate items. They are one primitive: **a script asking the engine
to run something with fewer capabilities than the script itself holds.**

That is `sandbox.run(source, { capabilities })`. It evaluates source in this
script's own sandbox holding only what the call names; `sandbox.held()` is the
set a narrowing subtracts from. It refuses a subset the caller does not itself
hold, refuses an unrecognised capability rather than dropping it, and nests
four deep against a budget shared with the turn that opened it.

The part that matters for both features is that it is a separate context
rather than a mask over the running one: the two share no object graph, so the
unrestricted parent cannot hand the restricted region a function and have it
called — a capability leak by reference that no mask catches. A filtered tool
list can be argued past. This cannot, because the check sits _under_ the
JavaScript rather than in it.

What it narrows is no longer only _what_ a capability does. `hosts` was added
beside `capabilities` for exactly the gap this paragraph used to describe —
`use_network` being one name whether the far end is an API this agent needs or
an attacker's collector — so [the egress question](#the-egress-question) now has
an answer the engine can enforce. Using it is this repository's work.

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

**Superseded, and the reason is worth keeping.** This was written before skills
existed. A slash command is now a second asset type with its own expansion
path, differing from a skill only in who reaches for it — and "who reaches for
it" is an entry point rather than a library. The thing actually missing is a
way for the person to name a skill from the page, which is one field and no new
format.

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
than by paste. `fetch` and `assetStorage` cover the first two.

Images are cheaper and more expensive than "they need the multimodal
content-block form", which is what this section used to say. Three cases, and
**none of them is blocked any more**:

- **An upload from the page needs nothing.** `request.files[].data` is already
  base64, which is exactly what a content block takes.
- **An image named by URL needs nothing either.** The API will fetch a URL
  source itself, so the bytes never have to come through this script.
- **An image from a channel needs one option.** This used to be the blocked
  case: `FetchResponse.body` was a string with no binary form, so a photo sent
  to the bot was unreachable. `fetch(fileUrl, { binary: true }).bodyBase64` now
  answers with it, in the same shape an upload arrives in — so the two paths
  converge on one content block and the adapter does not branch.

What is left is script work rather than engine work: a Telegram photo arrives
as a `file_id` and takes a `getFile` call before there is a URL to fetch, and
the result has to go into the turn as a content block rather than as text.

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

This list was written before `run_js`, and three of its six items were answers
to a tool list that was going to keep growing. It is not going to: the decision
[code as the action](#smolagents-and-codeact-code-as-the-action) records is the
decision not to have that problem. What is left is marked.

- **MCP client.** Connecting to external tool servers and offering their tools
  to the model. `McpClient` is already in the engine's JavaScript API, so an
  agent could mount somebody's MCP server as extra tools at runtime. **Still
  wanted**, and it is two items rather than one: mounting a _third-party_
  server is wiring, and it imports untrusted content into a run that can reach
  the network — see [the egress question](#the-egress-question). Mounting the
  engine's own is [a design question](#the-engine-is-already-an-mcp-server).
- **Subagents.** An isolated context for a fan-out task, whose tool output
  never enters the parent's transcript — only its final report. **Still
  wanted**, and "`personalTasks` nested one level" understates what it takes: a
  turn here cannot wait for anything, so the parent must _suspend_ and the
  child must resume it. That is the same machinery as
  [the suspended run](#three-features-one-primitive) — its fourth use — and the
  child needs a lane of its own, since the default lane is the person.
- **Background work.** Start something long, keep talking, be told when it
  finishes. **Still wanted**, and the same primitive again.
- **Tool search, deferred schemas.** Past a few dozen tools, load names only
  and fetch a schema when a tool is actually wanted — the same progressive
  disclosure as skills, applied to tools. **Superseded**: this is a cure for a
  large tool list, and `run_js` is the decision not to have one.
- **Hooks.** Deterministic code on lifecycle events — before a tool runs, after
  it returns, when a run stops. Guardrails the model cannot talk its way past,
  which is a different thing from instructions asking it not to. **Superseded**:
  `runTool` plus the deferred action already is this, and the lesson at
  [a gated tool must ask](#three-features-one-primitive) is the hook design
  arrived at the expensive way.
- **Structured questions.** A typed "pick one of these" tool, rather than the
  model asking in prose and hoping the answer comes back parseable.
  **Superseded**: a `plans` row, approved or rejected with a note and rendered
  as buttons on Telegram, is this. Widening it from two options to _n_ is an
  extension of that row, not a new mechanism.

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

**And there is a sharper version of the catch, which is the reason to decide it
rather than drift into it.** `McpClient.constructor` takes the _name of a
secret_, and the token is resolved host-side at the point of the call. So
mounting the engine's own MCP server with an owner-scoped token does not merely
reach past the delegation cap — it **launders** it: a delegated turn would be
holding, through a credential, authority that `delegation.rs` refuses to hand
it directly, and the refusal would still be in place and still be doing
nothing. The same is true of any third-party server whose token is worth more
than the run it is mounted into. A capability model that is enforced everywhere
except through a secret name is enforced nowhere that matters.

**Half of that turned out to be true already, and not as a consequence of
mounting anything.** `McpClient` was installed into every execution with no
capability check at all — so a `sandbox.run` narrowed to hold neither
`use_network` nor `read_secrets` still had one, and model-authored code inside
`run_js` could name any public address and any secret and have the engine
resolve that secret host-side and send it there as a `Bearer` token. That is
the person's own API key, two lines into a tool built to be narrower than the
turn around it. The engine has since gated every arm on both capabilities
(`fix: an MCP client is a way out, and was not gated as one`), including the
methods and not only the constructor, since `_callTool` rebuilds the client from
a JSON blob the caller hands it.

**The paragraph above still stands for the case it was actually about.** A
delegated turn holds `use_network` and `read_secrets` — the delegation base
keeps both, deliberately, since a run that cannot call out cannot do what people
delegate and dropping `read_secrets` would take away the script's own key. So
the gate does not stop a delegated turn mounting an owner-scoped server; it
stops a _narrowed_ one. The laundering question is unchanged and is still a
decision to make rather than drift into.

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

`fetchAll` is the neighbouring addition and the turn loop still does not call
it: several requests inside one wall-clock window rather than sequenced. It
matters for a fan-out turn — three tool calls that each take a second cost
three seconds of a budget, not one, without it. What changed since this was
written is that `run_js` advertises it, so model-written code can fan out even
though nothing this script wrote does.

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

**This used to say the distinction was nearly vacuous here, and that has
stopped being true.** It was written when the tools were `write_response`,
`remember`, `list_memories`, `recall` and `read_skill` — nothing writing
anything outside the person's own notes, so the agent sat close to permanently
in plan mode and an act mode had little to unlock.

Two of the three moments it named as the point where the distinction would
start carrying weight have since arrived, and a third that it did not name
turned out to matter more than either. `run_js` is the one: the mode now
selects a _capability set_ rather than a tool list, so plan and act differ in
what model-written code may do, which is a real difference enforced under the
JavaScript. The first channel adapter arrived too, which is where a run's mode
stops being a property of a page. What is still ahead is MCP —
[both halves of it](#the-engine-is-already-an-mcp-server).

The caution that goes with it is [the egress question](#the-egress-question):
the modes separate reading from writing, and they do not separate reading from
_sending_. A plan-mode run can already exfiltrate, because it holds
`use_network` and needs to.

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

**Built**, and the bet on writing the stopping half once paid in the most
direct way available: **the suspending half needed no new code at all.**

`advanceRun` already re-read the run's state after its tools had run, and
declined to queue a successor unless it was still `running` — written for a
cancel landing during a model call. So `request_approval` setting `waiting`
_is_ the suspend. The turn ends with its `tool_result` stored beside the
`tool_use` that asked for it, which is a point the conversation can legally
resume from, and nothing queues the next turn. One gate, three reasons to
pass through it, exactly as this section predicted.

Four things the resuming half turned out to need.

**The ordering is the whole design.** `/agent/decide` takes the transition out
of `waiting` **first and conditionally**, before it writes a message or queues
anything, because that single write is the mutex: two tabs pressing approve
both arrive and exactly one moves the run. This is the opposite of what
`advanceRun` does — it queues, then sets the state — and both are right, since
there the loser of a race has queued nothing, and here it would have queued a
turn charged to somebody's own key before discovering it lost.

**Then the message, then the task**, for a smaller reason that is just as
sharp: the queued turn is a thing that reads the conversation, so enqueueing
before appending lets it start against a history that does not yet say it was
approved.

**`write_script_data` is not in the act set and should never be.** It is the
one capability that would let model-written code reach the agent's own control
plane — `runs` holds the mode the capability set is selected by, `plans` holds
the row being decided, `messages` holds what the next turn reasons from — so a
turn holding it could approve its own plan, and the gate would be one the
thing being gated can open. The same decision blocks the other way in: a
forged call to the decide handler from inside the sandbox dies at its first
read, because `read_script_data` is withheld too. Both directions were tested
rather than argued: the strongest version of the forgery — correct auth shape,
working `json()`, naming a genuinely waiting run, launched from a run already
approved into `act` — gets `404 No such run`, and the plan stays pending.

**A rejection resumes rather than ends**, carrying the person's note, so the
model is told what was wrong and can propose something else. A rejection that
cannot say why teaches one bit and the next plan is a guess.

**A gated tool must ask, not refuse — and approving it must carry it out.**
This one cost two deployments to learn and is the most transferable thing
here. `remember` was gated first the way every other error in this file
works: refuse, and name the recovery. Asked to remember a preference, the
model met the refusal, decided out loud that "no approval needed since I'll
just act on it directly", and told the person it had noted something it had
not. A refusal is an instruction, and an instruction can be argued with.

So the tool raises the approval itself, and by the time the model reads an
answer the run is already suspended. That fixed the arguing and not the
lying: approved, resumed, the next turn called no tool at all and said
"Done." Relying on the model to repeat its own call was the same mistake one
step further along. A plan that defers a call now carries it — `plans` has
`action` and `payload` — and approving runs it, in the person's own request,
where `personalStorage` resolves to them.

Two things fall out that are better than the original design rather than
merely fixed. The plan shows the note itself, key and value, because those
are known exactly at the point the tool raises it rather than paraphrased by
a model describing an intention. And what happens is guaranteed to be what
was shown, which is the only reading of an approval button that means
anything. `MAX_STEPS`
bounds how many times that goes round.

The mode is stored as a string rather than a boolean, which is this section's
own caution about drifting to three or four modes taken at face value: a third
rung is a row value and a branch, not a schema change.

One cost worth knowing: the approval tool is withdrawn in `act`, so the turn
after an approval rewrites the cached prefix — the tools sit at the front of
it. Once per run, on the run that has just been given permission to do the
expensive half of its work.

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

**What this section is wrong about is the size of the win.** Read-only is the
right answer to a stranger's message _writing_ something. It is not an answer
to a stranger's message causing the agent to read this person's notes and send
them somewhere, which needs no write capability at all and is available in plan
mode today. Plan mode and the prompt-injection defence are the same lever for
one half of the problem and different levers for the other —
[the egress question](#the-egress-question) is the half this paragraph missed.

#### One caution

Two modes is the floor. Harnesses drift to three or four — plan, auto-accept,
unattended — because the thing that actually varies is _how often a person is
asked_, and that is a scalar rather than a toggle. Designing it as one from the
start avoids re-litigating it every time a tool is added.

### Checkpoints and rewind

Undoing a turn together with its side effects. `revisions.rs` is already this
shape, for an agent that writes files.

It stopped being hypothetical when `write_skill` landed: there is now something
the agent writes that outlives the run and changes what every later run does.
The concrete version is a skill's history, with a diff and a revert.

**The blocker this section named is gone.** It said an asset written from
JavaScript recorded no revision at all, so the history a page would show did not
exist — true when it was written, and fixed in the engine since
(`fix: a script writing its own asset records a revision`). `upsertAsset` now
records what the script consisted of afterwards, like every other path that
changes a script's files. So the history exists, and what is left is the page
over it plus the engine calls that read it: `list_revisions`, `diff_revisions`
and `revert_script`.

Worth knowing before building it: a revision is per **script**, not per file.
A skill's history is a query over the manifests rather than a row per skill, and
reverting lands the whole script on a revision rather than one file — which is
the right unit for undoing a change that spanned modules and the wrong one for
"put that skill back". `file_history` is the shape to reach for first.

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

Also not built, and a gap rather than a decision: **a run answered on a channel
reports nothing.** "Each person pays with their own key, so the bill is theirs
to see" is a claim about a page, and a Telegram run spends the same key with no
display anywhere. The rows are written either way — `turn_usage` does not know
which channel a run came from — so this is a delivery question, and the obvious
shape is a line under the answer rather than a second surface.

### Model and effort

Tier, thinking budget and output ceiling as per-run choices rather than
constants.

Moving a tier is **four** changes rather than the three the comment above
`MODEL` names, and the fourth is the one that fails silently: the minimum
cacheable prefix is a property of the tier (4096 on `claude-haiku-4-5`, 512 on
`claude-opus-5`), and the whole of [prompt caching](#prompt-caching) turns on
it. The other three are the model string, `PRICES`, and the thinking and effort
shape. Making this a per-run choice therefore means making the tier **one
record** — model, rates, minimum prefix, output ceiling — rather than four
constants that have to be moved together and currently sit in three places.

## Presentation

Markdown and syntax-highlighted code, diff views, images in and out, citations,
and **artifacts** — a panel where a generated page or document renders live
instead of scrolling past as text.

The artifact equivalent is unusually natural here, because the engine is a web
server — but **not as an asset**, which is what this section used to say. Two
things make the asset store the wrong home, both learned from `write_skill`:
`write_assets` is editor-tier and a delegated turn can never hold it, so every
artifact would have to go through an approval in the person's own request; and
assets belong to the _script_, so one person's artifact would be served to
everyone who uses the agent.

`personalStorage` behind a route is the shape that avoids both — per person by
construction, writable by a turn that has been approved to write, and still a
URL at the end of it.

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
either `enqueueFrom` or a reply carrying `inviteLink()`.

**Built, for Telegram.** Three things it turned out to need that this section
did not anticipate.

**The engine could not reach Telegram at all.** Its Bot API takes the token as
a path segment and offers no header form, and `http_client.rs` substituted
`{{secret:...}}` into header values only — deliberately, since a URL reaches
the audit line, the engine's logs and the far end's access log. So the adapter
began with an engine change: a secret may now fill in a **path**, the template
goes on carrying the scheme and host so every check runs against a string with
no credential in it, and every line that writes the URL down writes the
template. Worth knowing before picking a second channel: **Slack needs none of
this**, because it authenticates with a bearer header.

**The anonymous tier is what shapes the adapter.** Nobody is signed in when a
webhook arrives, and that tier holds the network, secrets, storage and the
queue but **no database access and no `view_logs`**. So the webhook can only
resolve a sender, queue, and reply — the run is opened by a delegated task
running as whoever linked the sender, and a button press is queued the same
way rather than acted on inline.

**The approval had to move.** A plan answerable only at a browser defeats the
point of reaching somebody on their phone, so a plan arrives as a message with
Approve and Reject under it. That forced `decide` out of `decideRun`: a
decision now comes from a page and from a chat, one of them has no request to
answer, and building the move twice is how the two come to disagree. The signature check is
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

What is left was filed as a choice rather than a fix, and the arrival of a
second surface has made it a live one. `lane` takes a name, so one lane per
_conversation_ rather than per person is a one-line change; `lane: null` opts
out entirely. With a chat and a page both able to start a run, one lane per
person means a message waits behind whatever the browser happens to be doing —
which is correct, and is not what somebody messaging a bot from a phone
expects. The counter-argument is that two runs for one person can then
interleave writes to the same notes, so the lane key is really a question about
what a _conversation_ is here, and the `runs` table now has the `channel` and
`chat_id` to answer it with.
`scriptTasks` defaults to no lane, since a script task belongs to the solution
and defaulting it would serialise the whole queue — worth knowing if this
agent ever queues work that is not per-person.

### Skills as markdown, written by the agent

Skills are YAML-fronted markdown rather than plugins: anyone can author one, no
code, hot-reloaded, and the agent can write its own.

**Both halves are built now.** `write_skill` takes a name, a one-line
description and a markdown body, and lands at `skills/<name>/SKILL.md` — the
same shape a hand-written one has, so nothing about reading them changed.

What it turned out to need was not a capability on the act set, which is what
this section assumed. **`write_assets` is editor-tier and `delegation.rs` caps
background work at `authenticated` on purpose**, so a delegated turn can never
hold it — a delegated task must not be the way to get a context that can author
a solution. The write therefore cannot happen in the turn at all. It happens
where the _approval_ does, in the person's own request under their own rights,
which is exactly what the deferred-action plumbing already did for `remember`.
The third use of that machinery, and the first that could not have been built
without it.

Two consequences worth keeping. It **always** asks, in both modes, because a
skill is an asset of the script and so changes the agent for everyone who uses
it — unlike a note, which is one person's. And a skill approved from the page
is written while one approved from a **Telegram button is refused**, since that
runs as a queued task; `performSkillWrite` says so in words rather than passing
on "Insufficient capabilities".

**And a skill the agent writes does not survive the next deploy**, which is
the interaction nobody designed and both features are right about. Git sync is
a sync rather than an append, so a file the repository does not have is one
the engine should not keep; the agent writes into the asset store; a pull
removes it. The first skill it wrote went exactly that way, reported as
`deleted: 1`.

The resolution is to treat an agent-written skill as a **proposal** and commit
the ones worth keeping — `agent/skills/<name>/SKILL.md`, which maps with no
configuration. Editing on the way through turned out to be the argument for
doing it by hand rather than automating it: the first skill promoted had
instructed the agent to run `git log`, which it cannot do, having no shell.
A person reading it was the only thing that would have caught that.

The alternative — pushing each skill back to git automatically — is available
(`push_to_git`) and was not taken, because a commit per skill is a lot of
ceremony for something the model is still learning to write well.

The original note below is kept because its framing was right even where its
mechanism was not.

The half worth adding is the agent
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

**Built.** Three handlers on `/agent/memories` — read, correct, delete — and a
collapsed panel above the activity log.

It stopped being only a principle while it was being built. Twice in one
afternoon this agent told its owner it had saved a preference and had not,
first by arguing past a refusal and then by answering "Done." with no tool
call at all, and both times the only way to find out was to read the database.
The panel is the thing that makes that a glance rather than a query.

What a person gets is the whole note rather than a preview, and the
distinction from `list_memories` is the entire point: the model is searching
an index for a key worth reading, a person is checking whether what the agent
believes about them is true, and a first line cannot answer that.

Two decisions worth keeping. `MAX_MEMORY_VALUE_CHARS` is **enforced** rather
than merely applied, because a field showing part of a note would save back
part of a note — an over-long value is sent marked, shown read-only, and can
still be deleted, since wanting a note gone does not require being able to see
all of it. And there is deliberately **no gate** on any of the three handlers:
the plan/act mode governs what the _agent_ may do while acting for somebody,
and this is the somebody, in their own request, editing their own store.

There is also deliberately no "add a note" form. Every note in the panel was
written by the agent, and the panel is for correcting what the agent believes.
Seeding preferences it never inferred is [project
instructions](#project-instructions), which is a different item with a
different shape — though the endpoint upserts, so the capability is there the
moment that item wants it.

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

**The advice above is still right and its timing claim is now false.** It was
written when there was no adapter and `run_js` did not exist, and it files the
untrusted-input leg as arriving _with_ the channels. Both legs it was waiting
for have landed, and the sequencing is worse than it reads:

- An unknown sender is already handled, and better than this section asked for.
  `enqueueFrom` resolves a stranger to **nobody** and throws, so there is no
  narrow scope to design — there is no run.
- What actually opened the exposure was `run_js`, not Telegram. Untrusted
  content reaches a run through anything that call fetches, whether or not a
  chat exists, and the same call can send. One turn, no approval, everything a
  stranger's web page told it to do.

So the remaining question is not "what may an unknown sender do" but "what may
a **linked** sender's message, or any fetched page, cause a run to send, and
where". That is [the egress question](#the-egress-question), and the
observation this section opens with — that retrofitting a constraint is far
harder than starting with it — now applies to this agent rather than to
OpenClaw.

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

**Built**, as `run_js`. Five things it turned out to need, four of which the
obvious implementation gets wrong.

**The capability list _is_ the feature, and the interesting half is what is
withheld.** Granting `read_secrets` would have been the natural thing — the
agent holds it, and the tool is narrowing from what the turn has. It is also a
two-line exfiltration of the person's API key, because `{{secret:...}}` is
substituted host-side inside a `fetch` and `use_network` is the one capability
the tool cannot do without. The engine refuses that pairing explicitly, with a
comment naming this exact case, which was reassuring to find rather than to
have to argue for. `read_script_data` goes for a quieter reason: `database` is
scoped to the _script_, so one person's turn could read every other person's
conversation out of `messages` and hand it back as a tool result.

**The list has to be intersected with `sandbox.held()`, not asserted.** `run`
throws when asked to keep something the caller does not hold, and a delegation
grant is free to be narrower than the list. Asking for what is wanted and
taking what is given is what keeps a read-only grant working instead of
failing every call.

**`ok: true` does not mean nothing was refused.** A refusal reaches the code
however that API already reports failure, and `database` reports it by
answering `{ error }` rather than by throwing — so a narrowed `database.query`
comes back as a _successful_ run whose value happens to be a refusal. Nothing
had to special-case it, since the message names the capability either way, but
a branch on `ok` that assumed otherwise would have been wrong and silent.

**The snippet is block-wrapped and evaluated as a script**, so the result is
the completion value of the last expression and `return` at the top level is a
syntax error. Both are in the tool description, because they are what a model
gets wrong on its first call and a wasted turn out of twelve is expensive.

**Errors arrive with QuickJS frames pointing into the engine's own preludes.**
A tool result is not paid for once — it is stored in the conversation and
resent on every turn after it — so the frames are filtered to the ones naming
the model's own source. Same argument as every other output-shape decision
here, just applied to the part nobody looks at.

What it does not do is write anything **until somebody says so**. The tool
holds `view_logs`, `use_network` and `read_assets` while a run is planning, and
gains `write_storage` once a plan has been approved — the approval step that
was the next item when this was written is now
[built](#three-features-one-primitive), and this is what it buys.

`read_storage` was on that list and is not any more; see
[the egress question](#the-egress-question). Code gets a note as a literal that
a `recall` fetched, which is a turn rather than a capability.

### OpenHands

<https://github.com/All-Hands-AI/OpenHands>

The most mature open-source coding agent. Its loop is an event stream — reason,
action, execution, observation — appended to a replayable log, with a pluggable
runtime behind it.

What to take is **the event log as the single source of truth**. This script
kept `messages` and `activities` as two tables written at different moments,
which can disagree about what happened in a run; one log with projections over
it cannot.

It is six tables now — `messages`, `activities`, `runs`, `interjections`,
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
