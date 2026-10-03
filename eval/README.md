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
node eval/run.mjs --only site-02,tool-01   # some tasks
node eval/run.mjs --keep --timeout 900     # keep the scripts; 15 minutes per task
```

`ENGINE_COOKIE` is the `Cookie` header of a signed-in browser session. That
person needs the editor role, must have stored an Anthropic key and granted the
agent permission to work while they are away (the page at `/agent` does both),
and pays for the run. Results go to `eval/results/<time>.json` with the pass
rate, turns and cost per passed task, and escalations. A run that ends in an
`error` activity or times out counts as escalated.

## The baseline (phase 1)

The baseline is today's agent with only its budgets raised, so a failure is a
finding about the platform and not about a turn that ran out of room:

1. In `agent/main.ts`, set `MAX_TOKENS` to 8000 and `MAX_STEPS` to 25.
2. `set_script_limits script=<the agent> jobTimeoutMs=120000`.
3. Deploy, run the suite, keep the result file.
4. Read the failures. The count of each cause is the work list for phases 2
   and 3. Record whether 8,000 output tokens fit in 120 s: any `timed out` row
   with high output tokens answers that open question.

Do not tune the tasks to make the baseline pass.
