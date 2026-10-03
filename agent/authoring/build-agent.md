# Building a small agent

A small agent is a route that sends one request to a model and answers with
the result. The starter has `main.ts` (the route and the call),
`lib/prompt.ts` (building the request and reading the answer, with tests) and
`skills/instructions.md` (what the model is told).

## Steps

1. Put the instructions the request describes in `skills/<name>.md` and import
   them with `import text from "./skills/<name>.md"`.
2. Build the model request in `lib/prompt.ts` as a pure function, and read the
   answer in another. Test both: they are the part that can be tested.
3. The route handler is `ask` in `lib/handlers.ts`. It validates its input
   first and answers 400 for a bad body, then makes one model call through
   `callModel`, a parameter that defaults to the real `fetch`. A test passes a
   fake `callModel`, so it never reaches the network; test the 200, the 400 and
   a model failure (502) with `makeContext` from `lib/testing.ts`.
4. Send the key as `"x-api-key": "{{secret:ANTHROPIC_API_KEY}}"`. The engine
   fills it in; the script never sees or stores the key.
5. Write everything in one `write_files` call, read the check, fix errors,
   `run_tests`, then `request_deploy`.

## Pitfalls

- One model call per request. A loop of calls does not fit a request's time.
- `fetch` is synchronous: use its result directly (`res.ok`, `res.json()`).
- The `anthropic-version` header is required: `2023-06-01`.
- The answer's text is `content[0].text`; check it exists before using it.
- Do not put the key, or text from a visitor, into a file or a log line.
- Tests must not call the model: pass a fake `callModel` to the handler.
