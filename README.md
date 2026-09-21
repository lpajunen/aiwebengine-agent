# aiwebengine-agent

A prompt-driven agent that runs inside [aiwebengine](https://github.com/lpajunen/aiwebengine): a page where a
person writes a prompt, and an activity log where they watch the agent work.
Each person brings their own Anthropic API key, so the deployment does not pay
for anybody's tokens.

## What it is

- `GET /agent` — the page: a prompt box, a key form, and the activity log.
- `POST /agent/prompt` — accepts a prompt and queues the run.
- `GET /agent/events` — SSE; activity as it happens, for this person only.
- `GET /agent/history` — the log, so a refresh loses nothing.
- `GET|POST|DELETE /agent/key` — the person's own API key.

There is no endpoint that advances a run. Each turn queues the next.

The model gets four tools: `write_response` (the only way the person sees
anything), and `remember`, `list_memories` and `recall` over notes in that
person's `personalStorage`. A fifth, `read_skill`, appears only when the
deployment has skills.

`list_memories` is what makes the notes readable rather than only writable:
`recall` needs a key, so anything written in an earlier run was unreachable
unless the model guessed the name. The listing gives each key, the note's size
and its first line — a note short enough to fit is its own preview, and no
`recall` follows. A `recall` that misses now names the keys that exist.

The model is `claude-haiku-4-5`, chosen on cost and on fitting the turn budget.
Moving up a tier is more than the `MODEL` string — `output_config.effort`, the
`thinking` form and the server-side refusal fallback all differ by tier, and
the comment above the constant says which go back.

## The one structural decision

**The run lives in the engine.** `POST /agent/prompt` queues the first turn and
answers; each turn queues the next; the page watches the SSE stream. Closing
the tab does not stop anything.

This used to be the other way round — the browser posted one request per turn —
because three engine facts left nowhere else for a turn to run: `registerOnce`
took effect only during `init()`, a scheduled job ran as
`UserContext::admin("scheduler")` and so could not reach the person's own API
key, and `dispatcher.sendMessage` ran its listeners inline.

All three are gone. `personalTasks` replaces all of them: a durable queue whose
work runs **as the person who asked for it**, so their key resolves and
`personalStorage` answers, exactly as they did inside their own request.

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
for the three things that change with it.

Raise the budget **before** raising either. A turn that runs past its budget
fails, and with `maxAttempts: 1` it is not retried — the run stops rather than
quietly costing twice.

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

A run is `running`, `cancelled` or `done` — and `waiting`, which nothing sets
yet. That last one is the seam for plan approval and per-tool permission:
those are not separate features but the same question, _may this run take
another turn_, and the half that stops a run is already written once for all
of them. What is missing is the half that resumes one.

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
write_asset script=<this script> name="skills/refunds/SKILL.md" content="---
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
read_logs uri=<this script> contains="agent: prompt"
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

## Layout

```
agent/
  main.ts     the script
  ui.html     the page          (asset)
  app.js      the browser loop  (asset)
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

Or push the two files directly with `write_assets` / `write_file`.

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
