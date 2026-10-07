# Evaluation suite

Tasks for measuring how well the agent builds simple scripts, and a runner that
scores it. The plan this serves is `docs/HAIKU_AUTHORING.md` in `aiwebengine`.

A task is a written request plus checks the run never sees. When Haiku fails
one, the fix goes into the platform — the engine, a template or a skill — not
into the task.

## Tasks

`tasks/<id>/task.json` holds the request and the checks; `acceptance.test.ts`,
when present, is the hidden test. Ten tasks to start; the plan calls for about
ten per shape.

| Shape | Tasks                                                                             |
| ----- | --------------------------------------------------------------------------------- |
| site  | `site-01` two-page site, `-02` sign-up page, `-03` status board, `-04` counter    |
| tool  | `tool-01` length converter, `-02` text statistics, `-03` API wrapper, `-04` dates |
| agent | `agent-01` FAQ bot, `-02` release-notes agent                                     |

A task passes when every check holds:

- **`tests`**: the hidden `acceptance.test.ts` is written into the script after
  the run, `run_tests` must pass, and any `minTests` the request asked for
  (the script's own tests) must exist. The request names the file and function
  the hidden test imports, since it can only test an interface it was told.
- **`registrations`**: `check_script` is clean and reports the named tool or
  route.
- **`files`**: a file the request asked for exists and contains the given text.
- **`probes`**: HTTP requests an anonymous visitor would send. The runner runs
  `deploy_script head` first, so a draft left behind a pinned stub is judged on
  what it wrote. The agent tasks only probe input validation: a probe that
  reached the model would need a key and would not be repeatable.

Every task script is named `eval-<id>`, and its routes live under `/eval-<id>`.
The runner deletes the script before and after a run so state-dependent probes
(a counter, a sign-up list) start from nothing.

## Running it

```bash
ENGINE_URL=https://your-engine ENGINE_COOKIE='<session cookie>' node eval/run.mjs
# when /engine/* is served from a management host of its own:
MANAGE_URL=https://manage.your-engine ...
node eval/run.mjs --only site-02,tool-01   # some tasks
node eval/run.mjs --keep --timeout 900     # keep the scripts; 15 minutes per task
node eval/run.mjs --kind chat              # the general agent, for comparison
```

`/engine/*` answers only on `server.management_hosts`; without `MANAGE_URL` the
runner assumes it is on `ENGINE_URL` and every judging call fails as not found.
The session cookie must be valid on both hosts.

A run may write skills into the agent itself, which then shape later runs. After
each task the runner removes the `skills/` files the task added and reports one
it changed (a pull from the repository restores that). `AGENT_SCRIPT` names the
agent script (default `agent`).

`ENGINE_COOKIE` is the `Cookie` header of a signed-in browser session. That
person needs the editor role, must have stored an Anthropic key and granted the
agent permission to work while they are away (the page at `/agent` does both),
and pays for the run. Results go to `eval/results/<time>.json` with the pass
rate, turns and cost per passed task, and escalations. A run that ends in an
`error` activity or times out counts as escalated.

Do not tune the tasks to make a run pass.
