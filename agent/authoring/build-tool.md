# Building a tool

A tool is something an AI client can call: a name, an input schema, and a
handler. The starter has `main.ts` (registration and a thin handler) and
`lib/example.ts` (the logic, with its test).

## Steps

1. Name the tool in `snake_case` exactly as the request says, and write its
   `inputSchema` from the request's arguments, marking the required ones.
2. Put the logic in `lib/<something>.ts` as an exported function with the
   signature the request gives. Pure functions test best.
3. The handler in `lib/handlers.ts` reads `context.args`, calls the function,
   and returns plain data (an object). It does not build an HTTP response.
   Test it with `makeContext({}, { value: 1 })` from `lib/testing.ts`; add it
   to the `Object.assign(globalThis, {...})` line in `main.ts`.
4. Throw an `Error` for input the tool cannot accept; the caller sees it.
5. Delete the starter's placeholder `lib/example.ts` and `lib/example.test.ts`
   (use `remove` in `write_files`) once your own files replace them.
6. Write tests in `lib/<something>.test.ts` for the normal case, an edge and
   the error. Write everything in one `write_files` call, read the check,
   fix errors, `run_tests`, then `request_deploy`.

## Pitfalls

- The tool is registered in `init()` with `mcpRegistry.registerTool`; the
  handler named there must be a global: list it in `Object.assign(globalThis,
{...})` in `main.ts`.
- To call another service use `fetch(url, { headers })`: it returns the finished
  response, with no `await`. Keep the parsing in a pure function so a test can
  feed it a sample body instead of calling the network.
- A secret goes in a header as `{{secret:NAME}}`; never write a key into a file.
- Keep `lib/` files importing each other with the `.ts` extension.
- Tests run without a network call you did not stub: test the parsing, not
  the request.
