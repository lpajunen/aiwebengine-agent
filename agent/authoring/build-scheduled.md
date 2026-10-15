# Building a scheduled app

A scheduled app does something for each signed-in person at a time they
choose, while they are away. The starter has a page (`home`) where they give
the app permission and choose a time and time zone, a form handler
(`saveSchedule`) that calls `personalTasks.schedule`, and the scheduled run
(`runDaily`) that does the work as that person and keeps the result in their
`personalStorage`. The pure parts are in `lib/schedule.ts`, with tests.

## Steps

1. Put the work the request describes in `doWork` in `lib/handlers.ts`, or in
   a pure function in `lib/` that `runDaily` calls. Test that function.
2. Keep `runDaily` as the scheduled run, or rename it in three places: the
   function, the `Object.assign(globalThis, {...})` line in `main.ts`, and the
   `handler` that `saveSchedule` passes to `personalTasks.schedule`.
3. Change the page in `home` to show what the run left. Keep its three states:
   not signed in (a link to `/auth/login`), no permission (a link to
   `consentUrl`), and the schedule with its form.
4. Test the handlers with `makeContext` and the fake `deps` in
   `lib/handlers.test.ts`; a test never reaches the real `personalTasks`.
5. Remove starter files you no longer use. Write all the files in one
   `write_files` call, read the check it returns, fix every error, then
   `run_tests`, then `request_deploy`.

## Pitfalls

- The run is a task, not a request: `context.request` is absent there. What
  the run is for is in `context.meta.schedule` (`key`, `scheduledFor`).
- The run acts through the person's grant. Without `personal_storage` and
  `write` it cannot keep anything; `hasScopes` checks, and `home` sends them
  to the consent page.
- A grant lapses after at most 90 days and the schedule pauses without a word.
  Keep the `expiryNotice` the run stores, and show it.
- `cron` is five fields in the person's `timeZone`: `"30 7 * * *"` is 07:30
  every day. Runs closer than the engine's minimum interval are refused.
- Calling `schedule` again with the same key replaces it and keeps its next
  run; it is safe on every save.
- A run that throws is retried, and three runs in a row that fail pause the
  schedule. Throw only for what a retry could fix.
