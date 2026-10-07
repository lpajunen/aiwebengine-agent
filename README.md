# aiwebengine-agent

A prompt-driven agent that runs inside [aiwebengine](https://github.com/lpajunen/aiwebengine): a page where a
person writes a prompt, and an activity log where they watch the agent work.
Each person brings their own Anthropic API key, so the deployment does not pay
for anybody's tokens.

## What it is

- `GET /agent` — the page: a prompt box, a key form, the memory panel and the
  activity log.
- `POST /agent/prompt` — accepts a prompt and queues the run. With a `runId`
  it continues that conversation (the earlier messages are the context; the
  conversation's kind stays what it was); without one it starts a new one.
- `GET /agent/conversations` — the person's earlier conversations, newest
  first; `GET /agent/history?runId=` shows one of them, and a prompt sent with
  its `runId` continues it.
- `POST /agent/new` — starts a new conversation: the page shows only the
  newest run id, and the next prompt carries none of the earlier context.
  Refused while a run is working.
- `GET /agent/events` — SSE; activity as it happens, for this person only.
- `GET /agent/history` — the log, so a refresh loses nothing.
- `POST /agent/cancel` — stops a run; `POST /agent/say` speaks into one.
- `POST /agent/decide` — approves or rejects a plan a run is waiting on.
- `GET|POST|DELETE /agent/memories` — what the agent remembers, and corrections.
- `GET|POST|DELETE /agent/key` — the person's own API key.
- `POST /agent/telegram` — the bot webhook.

There is no endpoint that advances a run. Each turn queues the next.

`agent/main.ts` is the root script and holds the loop. Five modules sit beside
it, because a root script cannot `export` and a test module reaches its
subject by importing it — so anything under test had to move out:

| Module            | What it holds                                             |
| ----------------- | --------------------------------------------------------- |
| `protocol.ts`     | reading what the model sent, half-written JSON included   |
| `capabilities.ts` | what model-written code may do, and the pair it may not   |
| `budget.ts`       | what a run has spent, and when it has had enough          |
| `skills.ts`       | the SKILL.md format, written and read                     |
| `plans.ts`        | decoding the call an approval carries                     |
| `engine.ts`       | which management tools only read, and their arguments     |
| `authoring.ts`    | what a script-building run is given, and how it is judged |

Their tests are `agent/*.test.ts` — 113 cases — run with the `run_tests` tool
or `POST /engine/run_tests` with `{"script": "<this script>"}`.

The model gets five tools: `write_response` (the only way the person sees
anything), `remember`, `list_memories` and `recall` over notes in that person's
`personalStorage`, and `run_js`, which runs model-written JavaScript in a
sandbox holding less than the turn around it. Five more appear conditionally:
`request_approval` while a run is planning, `read_skill` when the deployment
has skills, `write_skill` with it, and `engine_tools` / `engine_call` when the
person has granted this app management authority.

`list_memories` is what makes the notes readable rather than only writable:
`recall` needs a key, so anything written in an earlier run was unreachable
unless the model guessed the name. The listing gives each key, the note's size
and its first line — a note short enough to fit is its own preview, and no
`recall` follows. A `recall` that misses now names the keys that exist.

They are also the only way to a note. `run_js` deliberately holds no
`read_storage`: it can call the network, and private data plus a way out in
one execution is two thirds of a prompt-injection story that a fetched page
supplies the rest of. So code gets a note as a literal that a `recall`
fetched, which costs a turn and means a note only leaves if the model itself
carries it.

The model is `claude-haiku-4-5`, chosen on cost and on fitting the turn budget.
Moving up a tier is more than the `MODEL` string — `output_config.effort`, the
`thinking` form and the server-side refusal fallback all differ by tier, and
the comment above the constant says which go back. So do `PRICES`, and so does
the minimum cacheable prefix, which is the one that changes nothing visible
until a bill arrives.

## Building scripts

A run started with `kind: "author"` (the **Build a script** box on the page)
builds a script instead of chatting. It needs the `author` grant, and it has its
own tools, budgets and prompt; chat runs are unchanged.

| Tool                                                                          | What it does                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_script`                                                               | Copies the starter for a shape (`site`, `tool` or `agent`) from `template-<shape>`, writes a placeholder first and pins it, and answers with the primer and the guide for that shape                                             |
| `open_script`                                                                 | Takes a script the person already owns instead of creating one; pins it at what is served, so nothing written is served until approved                                                                                           |
| `write_files`, `edit_file`                                                    | Change the script; each answers with the engine's `check`                                                                                                                                                                        |
| `read_file`, `check_script`, `run_tests`, `read_logs`                         | Look and verify                                                                                                                                                                                                                  |
| `list_revisions`, `revert_script`, `list_tasks`, `cancel_task`, `eval_script` | Revision history; restore an earlier revision as a new one (never forced); queued work, and cancelling one pending task (never the finished ones); run a snippet against what is served now (writes rolled back, not switchable) |
| `request_deploy`                                                              | Runs the check and the tests, refuses if either fails, and asks the person; approving moves the pin to head                                                                                                                      |
| `list_secrets`, `write_secret`, `delete_secret`                               | Keys only. A write or delete asks the person first, the plan never shows the value, and the stored copy is cleared once they decide. Live at once, not at deploy                                                                 |
| `get_git_status`, `push_to_git`                                               | Status is free. A push asks the person first, goes only to where the script already tracks, and only when it is ahead; never a chosen repository or `force`. `pull_from_git` is not offered                                      |

What keeps a small model on the rails:

- **Drafts are pins.** The placeholder keeps serving while the draft advances,
  so nothing half-written is ever what visitors reach.
- **Only its own scripts.** Every tool is bound to what `create_script` made in
  this run (`run_scripts`); there is no argument that reaches another script.
- **A turn that talks and calls nothing is nudged** to call a tool, up to three
  times, rather than ending the run having only announced the work.
- **The same failure three times stops the run** and writes a handoff note — the
  request, the script and revision, the last verdict and what was tried — for a
  person to give a developer. Running out of turns writes one too.
- **Budgets:** 8,000 output tokens and 25 turns, against 1,024 and 12 for chat.
  Set the job timeout for this script to 120 s:
  `set_script_limits script=agent jobTimeoutMs=120000`.

The starters live in
[`aiwebengine-template`](https://github.com/lpajunen/aiwebengine-template) and
are pulled with `pull_from_git(repo: "lpajunen/aiwebengine-template", prefix:
"template")`. The guides are `agent/authoring/*.md`; `primer.md` is a copy of
`assets/script-primer.md` in `aiwebengine` and is refreshed from it when that
changes. `eval/` holds the tasks that measure all of this.

## The one structural decision

**The run lives in the engine.** `POST /agent/prompt` queues the first turn and
answers; each turn queues the next; the page watches the SSE stream. Closing
the tab does not stop anything.

Turns run on `personalTasks`: a durable queue whose work runs **as the person
who asked for it**, so their key resolves and `personalStorage` answers,
exactly as they would inside their own request.

Two things follow from running while the person is away.

### It takes their permission

`personalTasks.enqueue` refuses without a live grant. The person gives one on
the engine's consent page, which names what is being asked for, and withdraws
it from `/auth/account` — withdrawing also cancels whatever is still queued.

This agent needs both scopes: `secrets` for the model key, `personal_storage`
for the remember/recall notes. A grant covering only one reaches only that one;
the engine enforces each at the surface it names.

The page asks for permission before the first run rather than after a refusal,
and says so again if the grant lapses. Grants expire — 30 days by default, 90
at most — so a long-lived agent will meet that eventually.

### A turn is attempted exactly once

The queue retries a failed task five times by default. For an agent turn that
would mean re-sending the whole conversation and paying for another model call
on somebody's personal key, so every enqueue passes `maxAttempts: 1` and lets
`MAX_STEPS` do the bounding.

## Where the key lives

`secretStorage.setSecret` writes to `user_secrets`, keyed by
`(script_uri, user_id, name)`, encrypted at rest. There is deliberately **no
read** from JavaScript — `secretStorage.exists()` only says whether a key is
there — so this script cannot read, log or forward anybody's key. The only way
to use it is the header template:

```ts
headers: { "x-api-key": "{{secret:ANTHROPIC_API_KEY}}" }
```

which the engine substitutes host-side for whoever is calling.

The template is substituted anywhere inside a header value, so
`"Authorization": "Bearer {{secret:K}}"` works as well as the whole-value form
this script uses. That was not true once — the engine matched only a value that
was _nothing but_ a template, which put every bearer-token API out of reach of a
per-person key.

For a queued turn, "whoever is calling" is the person who started the run, by
their grant. Their key is reachable while they are away, and nobody else's ever
is.

## Budgets to design against

|                |                                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| One turn       | `javascript.job_timeout_ms`, 60 s by default — a turn is a job, not a request   |
| The model call | Synchronous `fetchStream`, its timeout clamped to what is left of the turn      |
| Streaming      | The answer is sent on as it is written, so the page fills in during a turn      |
| Concurrency    | Each in-flight turn holds one of `max_concurrent_executions` slots and a thread |

A turn is queued work, so it gets the job budget rather than the 10 s a request
gets. And that can be raised for this script alone, without touching any other
solution on the instance:

```
set_script_limits script=<this script> jobTimeoutMs=120000 note="agent turns call a model API"
```

`MAX_TOKENS` is 1024 and the model is `claude-haiku-4-5` because both were
chosen when a turn had ten seconds. With a job's budget there is room to raise
the first and to move up a tier on the second — see the comment above `MODEL`
for what changes with it.

Raise the budget **before** raising either. A turn that runs past its budget
fails, and with `maxAttempts: 1` it is not retried — the run stops rather than
quietly costing twice.

## When a run gets long

Every turn resends the run so far, so a long run grows until it is expensive
and then until it will not fit. When a run passes **30,000 prompt tokens** or
**42 messages**, the next turn is spent folding the conversation into a
summary instead: one model call, the whole history replaced by its own notes,
and the turn after that carries on from there.

The whole history goes, not the older half. Keeping recent turns verbatim is
the shape that looks obviously better and is not — a kept turn carries tool
results whose `tool_use` sits in a message that was thrown away, and the API
requires the two to be adjacent. Summarise-and-replay-nothing is simpler and
is what the model is trained for.

It happens at the top of a turn and nowhere else, because that is the only
point where every tool call has its result beside it. Mid-turn there is a call
waiting on an answer, and folding that away asks the model to continue from a
question it can no longer see.

Two consequences worth knowing. Compaction resets the prompt cache, which is
the cost of it. And turns are counted on the run's row rather than by counting
assistant messages, because a compacted run has none left — counting them
would hand every compacted run a fresh budget and a run could never end.

`MAX_STEPS` is the only thing bounding a run's length, which makes raising
it a decision about money rather than about correctness.

## Stopping and steering a run

The run lives in the engine, so closing the tab does not stop it — which used
to mean nothing did. A run now has a row of its own:

- `POST /agent/cancel {runId}` stops it. The queued task is cancelled so a turn
  that has not started never does, and the run's state is written so a turn
  already in flight stops at the next boundary. Both, because either alone
  leaves a case open.
- `POST /agent/say {runId, text}` speaks into a run that is still working. It
  is delivered at the top of the next turn, which is the soonest the model can
  be told anything without it arriving mid-decision. Queued rather than
  appended when it arrives: text written into the conversation mid-turn would
  sit before an assistant message that never saw it, and the turn after would
  read that as an aside already answered.

On the page the button becomes **Send** while a run is working and a **Stop**
appears beside it. A page opened onto a run started somewhere else gets both,
since the run is not the tab's.

A run is `running`, `cancelled`, `done` or `waiting`. That last one is the seam
plan approval and per-tool permission both hang off: they are not separate
features but the same question, _may this run take another turn_, and the half
that stops a run was written once for all of them. `request_approval` sets
`waiting` and the run suspends where it stands; `POST /agent/decide` — or a
Telegram button — is the half that resumes it.

## Managing the engine

The agent can answer "who are the users", read a script, list revisions or
deploy one — the engine's own management tools, the same ones `/mcp` publishes.

**Two tools, not fifty-two.** `engine_tools(area)` asks the engine what it
serves and `engine_call(name, args)` calls one. Handing the model fifty
schemas would be ten to fifteen thousand tokens resent every turn, on a prompt
whose cached prefix is otherwise a few hundred — and a list written into this
script would drift from the engine the first time it gained a tool.

**It is off unless somebody turned it on.** Two things have to be true and
neither is this script's to decide:

- The engine installs the `engine` global only where authority came from a
  credential — a request, or a delegated task. A scheduled job runs as a
  synthetic administrator and does not get it, and neither does `run_js`.
- The person has granted `author` or `administer` on their account page.

`hasEngineAuthority()` reads `sandbox.held()` to check the second, so a run
with no grant is never offered the tools at all rather than being offered them
and refused. A tool whose every answer is "you may not" is worse than no tool.

**You are acting as them.** Every call is checked against what that person's
account may do, so a refusal means their account may not do it — the agent is
told to report that rather than look for another way round. Granting
`administer` does not make the app an administrator; it lets it be one _as
you_, and only if you are.

**Reads answer; changes ask.** `engine.ts` classifies a tool by its name — the
engine has no answer to give, since a tool reports what it did rather than what
it would do — and **anything unrecognised counts as a write**. Being asked
about a read costs a turn; not being asked about a write costs whatever it
changed. A write in plan mode is refused with the name of the tool that lifts
it, exactly as `run_js` writes are.

Every call appears in the activity log before it runs, like the code `run_js`
writes, for the same reason: an agent that does something nobody was shown is
the thing people object to.

### Setting it up

```text
set_script_limits script=<this script> jobTimeoutMs=120000
```

Then, as the person who wants the agent to manage things: open
`/auth/delegate?script=<this script>`, tick **Administer this engine as you**,
and start a run. The checkbox is disabled with a reason if the account is not
an administrator.

## Skills

A skill is a folder of instructions the agent reads when it decides the work
calls for them. They are assets of this script, so a deployment grows its own
library without touching `main.ts`:

```
skills/refunds/SKILL.md
skills/refunds/policy.md
skills/invoices/SKILL.md
```

A `SKILL.md` carries a description in front matter, and the instructions after
it:

```markdown
---
name: refunds
description: Handling a refund request. Read before promising anything.
---

Check the order is inside 30 days, then ...
```

**The folder name is the skill's name** — it is the one identifier that cannot
disagree with itself, and it is what `read_skill` takes. A `name:` in the front
matter is allowed and ignored, so a `SKILL.md` written for another harness
drops in unchanged.

Only the names and descriptions ride in the system prompt; a body is fetched
when the model asks for it. That is what makes a large library affordable —
forty skills cost forty lines until one of them is wanted. A `SKILL.md` may
point at files beside it (`policy.md` above) and `read_skill` will fetch those
too, from that folder and nowhere else.

Write one with the engine's own asset tools:

```
write_file script=<this script> name="skills/refunds/SKILL.md" content="---
description: Handling a refund request.
---

Check the order is inside 30 days."
```

A deployment with no skills gets the system prompt it had before any of this
existed, byte for byte, and is not offered `read_skill` at all.

Two ceilings: the index names at most 64 skills, and a body is cut at 32,000
characters. The index is rebuilt only when a skill file changes — it is kept
in `scriptStorage` under a fingerprint of the skill files and their
modification times, so the steady state is two asset reads a turn rather than
one per skill.

### The agent writes them too

`write_skill` lets the agent write down a procedure it has just worked out.
It **always** pauses and asks, in both modes, because a skill is an asset of
the script — it changes what this agent does for everyone who uses it, and
keeps doing so until somebody notices. A note is one person's; a skill is not.

It also cannot write one itself. `write_files` is editor-tier and
`delegation.rs` caps background work at `authenticated` on purpose, so a
delegated turn can never hold it. The write happens where the _approval_ does,
in your own request under your own rights — which is why a skill approved on
the page is written, and one approved from a **Telegram button is refused**.
That is the engine's rule holding rather than a gap, and the refusal says so.

### Promoting one into the repository

**A skill the agent writes does not survive the next `pull_from_git`.** Git
sync is a sync rather than an append — a file the repository does not have is
a file the engine should not keep — so a deploy removes anything the agent
wrote into the asset store. Nothing is wrong when that happens; it is the
deployment model doing what it says.

So treat an agent-written skill as a **proposal**. Keep the ones worth keeping
by committing them:

```bash
# 1. Read what the agent wrote
read_file script=<this script> path="skills/<name>/SKILL.md"

# 2. Put it in the repository, editing it on the way through
agent/skills/<name>/SKILL.md

# 3. Commit, push, pull — the pull now preserves it rather than deleting it
```

The layout needs no configuration: `agent/` is the script because it holds
`main.ts`, so everything under it lands as an asset at the same relative path,
and `agent/skills/<name>/SKILL.md` becomes `skills/<name>/SKILL.md`.

### Knowing there is one to promote

**Neither the revision history nor the git status will tell you**, and that is
worth knowing before you go looking. An asset written from JavaScript records
no revision and does not move the binding off `in_sync` — written one and
watched both report nothing — so a skill sitting only in the asset store is
invisible to `list_revisions` and `get_git_status` alike, right up to the pull
that deletes it.

What does tell you is the asset list, compared against the repository:

```bash
# what the engine has
list_files script=<this script>     # skills/<name>/SKILL.md entries

# what the repository has
ls agent/skills/
```

Anything in the first and not the second is unpromoted, and will go on the
next deploy. The agent also says so when it writes one — the activity reads
`Wrote the skill "x". It lives in this engine's assets — commit it to
agent/skills/x/SKILL.md to keep it` — which is the moment you are most likely
to be looking.

Editing on the way through is the point rather than a chore. The first skill
this agent wrote for itself instructed it to run `git log` — which it cannot
do, having no shell — and that was only going to be caught by a person reading
it.

`agent/skills/.markdownlint.json` turns off `MD041` for this directory: a
`SKILL.md` opens with front matter rather than a heading, and that rule is
about documents for people.

## What a run costs

Every turn resends the run so far, so the bill grows with the length of a run
rather than with the prompt. The request asks for the prompt to be cached,
which turns most of that resending into cache reads at about a tenth of the
price — each turn reading back what the turn before it wrote.

It does nothing until a run's whole prompt passes **4096 tokens**, and that is
the model's number rather than a choice: `claude-haiku-4-5` has the highest
minimum cacheable prefix of any current model, and a shorter prefix is refused
silently — no error, just a `usage` reporting nothing cached. The tools and the
system prompt come to roughly 400 tokens between them, so caching only those
would never fire once. What crosses 4096 is a long conversation, which is
exactly the run worth making cheaper. Moving up a tier lowers the threshold
(512 on `claude-opus-5`), so caching starts paying sooner there, not later.

The page shows what the run on screen has cost — turns, tokens in and out,
how much of the input came from cache, an estimate in dollars, and a meter for
the largest prompt against the model's context window. Each person pays with
their own key, so the bill is theirs to see.

The dollar figure is an estimate at the rates in `PRICES`, **and those move
with `MODEL`** — a stale price list still renders and still looks
authoritative. The rates are kept apart rather than averaged because caching
is most of what a run costs or saves.

Every turn also logs what it spent, because a prefix that stops matching still
answers and is simply billed in full:

```
read_logs script=<this script> contains="agent: prompt"
agent: prompt 5312 tokens (cached 5000, wrote 300, new 12), reply 44
```

`cached` should grow turn over turn while `wrote` stays near the size of what
the last turn added. `cached` sitting at 0 in a run well past a few thousand
tokens means something above the breakpoint is being rewritten between turns.

## When a run misbehaves

Queued work is visible to an administrator without reading this script's own
log:

```
list_tasks   script=<this script>
cancel_task  script=<this script> task=<id>
```

A turn that failed keeps its row and the error that ended it. A run that is
stuck is a pending task with a `runAt` in the future.

## Telegram

The agent answers on Telegram as well as on its page, with the same run, the
same log and the same approvals — a plan arrives as a message with **Approve**
and **Reject** under it.

### Who can message it, and whose agent runs

Anyone can message a Telegram bot, so the question that matters is whose agent
a message starts. **This script cannot decide that**, and that is the design
rather than an omission: there is no call here that takes a user id.
`personalTasks.enqueueFrom` names a _sender_ — a channel and an identity as
that channel spells it — and the engine resolves it against the links people
have consented to. An unlinked sender resolves to nobody and throws.

So the worst a bug in the webhook can do is claim the wrong _sender_. It
cannot name a different account, and it cannot enumerate one.

Linking is a consent flow, not a URL. A stranger gets a single-use invitation
replied **into their own chat**, because being able to read that chat is the
only evidence of ownership the engine can have. A link that named the sender
would be one anybody could build for anybody — and linking somebody else's id
first does not merely squat on it, it intercepts them.

A run started from Telegram begins in plan mode like every other, so nothing
is written until a button is pressed.

### Setting it up

Three things, none of which the script can do for itself.

**1. A bot, and its token as a script secret.** Get one from
[@BotFather](https://t.me/BotFather), then store the token as a secret rather
than a `scriptStorage` value, so that it is never handed to JavaScript at all:

```text
write_secret uri=<this script> name=TELEGRAM_BOT_TOKEN value=<token> scope=script
```

**2. A webhook secret**, which Telegram echoes back on every call so the
script can tell a real delivery from a forged one. It lives in `scriptStorage`
because checking it means _comparing_ it, and the engine never returns a
secret's value to JavaScript. `run_js` holds no `read_storage`, so
model-written code cannot read it back; what it is worth is bounded anyway,
since a forged delivery still has to name a sender somebody has linked.
Generate something long and random, then:

```js
// eval_script, as an administrator
scriptStorage.setItem("telegram:webhook_secret", "<a long random string>");
```

**3. Point Telegram at the route**, passing the same secret:

```js
// eval_script, as an administrator
fetch("https://api.telegram.org/bot{{secret:TELEGRAM_BOT_TOKEN}}/setWebhook", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "https://<your host>/agent/telegram",
    secret_token: "<the same long random string>",
    allowed_updates: ["message", "callback_query"],
  }),
});
```

The webhook refuses every call until step 2 is done: unconfigured means
closed, rather than accepting anyone who omits the header.

### What it needs from the engine

A token in a URL. Telegram takes its bot token as a path segment and offers no
header form, and this engine substitutes `{{secret:...}}` into header values
only — deliberately, since a URL reaches the audit line, the engine's logs and
the far end's access log. That is why `http_client.rs` grew `resolve_url`: a
secret may now fill in a **path**, the template keeps carrying the scheme and
host so every check runs against a string with no credential in it, and every
line that writes the URL down keeps writing the template.

**An engine older than that change cannot run this.** The bot token would be
sent to Telegram as the literal text `{{secret:TELEGRAM_BOT_TOKEN}}` and every
call would fail.

### What the engine still cannot do

Verify that a message came from the sender it names. Telegram's shared secret
proves the _call_ came from Telegram; nothing proves the body was not edited
by whoever holds that secret. Which is why `telegramCallIsGenuine` refusing is
the only place this script returns a non-2xx, and why losing that secret is
bounded: it buys forged messages from a sender who already trusts this bot,
not access to the bot and not access to anybody's account.

## Layout

```
agent/
  main.ts     the script
  public/
    ui.html   the page          (asset)
    app.js    the browser loop  (asset)
types/
  aiwebengine.d.ts   snapshot for typechecking
```

`agent/` holds `main.ts`, which is what makes it one script to the engine's git
sync: a top-level directory with an entry point becomes a script, and
everything beside it becomes that script's assets. `types/` and this README sit
outside any script and are never pulled in.

## Installing it

With the repository pushed to GitHub, from an engine you administer:

```
pull_from_git  repository=<owner>/aiwebengine-agent
```

Or push the two files directly with `write_files` / `write_file`.

Each person signs in, stores their own key at `/agent`, and grants the agent
permission to work while they are away — all three from that page.

The one thing an administrator may want to set is the turn budget, since the
default 60 s suits a short turn rather than a long one:

```
set_script_limits script=<this script> jobTimeoutMs=120000
```

## Typechecking

```bash
npx tsc -p tsconfig.json
```

`types/aiwebengine.d.ts` is a snapshot. The authoritative copy is served by the
engine itself at `/engine/types/v{version}/aiwebengine.d.ts` — refresh it from
the engine you deploy to, since several of the limits in its comments are that
deployment's configuration.
