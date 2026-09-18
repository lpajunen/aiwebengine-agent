# aiwebengine-agent

A prompt-driven agent that runs inside [aiwebengine](https://github.com/lpajunen/aiwebengine): a page where a
person writes a prompt, and an activity log where they watch the agent work.
Each person brings their own Anthropic API key, so the deployment does not pay
for anybody's tokens.

## What it is

- `GET /agent` — the page: a prompt box, a key form, and the activity log.
- `POST /agent/prompt` — accepts a prompt and opens a run.
- `POST /agent/step` — advances one run by exactly one turn.
- `GET /agent/events` — SSE; activity as it happens, for this person only.
- `GET /agent/history` — the log, so a refresh loses nothing.
- `GET|POST|DELETE /agent/key` — the person's own API key.

The model gets three tools: `write_response` (the only way the person sees
anything), `remember` and `recall` (notes in that person's `personalStorage`).

The model is `claude-haiku-4-5`, chosen on cost and on fitting the turn budget.
Moving up a tier is more than the `MODEL` string — `output_config.effort`, the
`thinking` form and the server-side refusal fallback all differ by tier, and
the comment above the constant says which go back.

## The one structural decision

**The browser drives the loop.** The page posts `/agent/step` repeatedly until
the run reports itself done, instead of the engine looping on its own. That is
not a stylistic choice — three engine facts rule out every alternative:

1. `schedulerService.registerOnce` takes effect only during `init()`. A request
   handler calling it gets back a string saying nothing was registered, so a
   turn cannot schedule the next one.
2. A scheduled job runs as `UserContext::admin("scheduler")`, and `fetch`
   resolves `{{secret:...}}` against the calling user. A background job looking
   for the person's key would look under a user named `scheduler` and miss it.
   Per-person keys are reachable only from that person's own request.
3. `dispatcher.sendMessage` runs listeners inline, on the sender's budget — it
   is not a way to start background work.

So a turn is an HTTP request under the person's session. Their identity is
present, their key is reachable, `personalStorage` works, and every turn gets a
fresh `javascript.execution_timeout_ms` instead of several sharing one.

The consequence: closing the tab stops the run. `TODO-agent.md` in the engine
repository lists what the engine would need for a run that continues without
one.

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

⚠️ **The template must be the entire header value.** `http_client.rs` matches
`starts_with("{{secret:") && ends_with("}}")`, so `"Bearer {{secret:K}}"` is
sent literally. Anthropic's `x-api-key` header happens to fit; a bearer-token
API does not. (The published type declarations show `"Bearer {{API_TOKEN}}"`,
which does not work — see `TODO-agent.md` item 7.)

## Budgets to design against

|                |                                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| One turn       | `javascript.execution_timeout_ms`, 10 s by default, engine-wide                 |
| The model call | Synchronous `fetch`, its timeout clamped to what is left of the turn            |
| Streaming      | None — `fetch` buffers. The log updates per turn, not per token                 |
| Concurrency    | Each in-flight turn holds one of `max_concurrent_executions` slots and a thread |

The 10 seconds is the real pressure, which is why `MAX_TOKENS` is 2048 and the
model is `claude-haiku-4-5`. An engine hosting agents wants a longer
`javascript.execution_timeout_ms` — but it is global, so raising it affects
every script on the instance.

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

The script needs no configuration beyond each person signing in and storing
their own key at `/agent`.

## Typechecking

```bash
npx tsc -p tsconfig.json
```

`types/aiwebengine.d.ts` is a snapshot. The authoritative copy is served by the
engine itself at `/engine/types/v{version}/aiwebengine.d.ts` — refresh it from
the engine you deploy to, since several of the limits in its comments are that
deployment's configuration.
