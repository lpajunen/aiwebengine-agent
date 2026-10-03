# Building a site

A site is pages and a few routes. The starter has a home page, a stylesheet and
a `renderPage` helper in `lib/page.ts`. Keep the routes under `/<name>`.

## Steps

1. Decide the routes from the request. Each route is a handler function in
   `main.ts` and one `registerRoute` line in `init()`.
2. Pages: build the HTML in `lib/` with `renderPage`, return it with
   `ResponseBuilder.html`. Put static files in `public/` and register them with
   `{ file: "public/x.css" }`.
3. Data the site keeps (sign-ups, counters, a list): `scriptStorage` as JSON
   text, read, changed and written back in one handler.
4. Put the logic that decides things in `lib/*.ts` and test it in
   `lib/*.test.ts`. `main.ts` parses the request, calls `lib/`, and answers.
5. Remove starter files you no longer use. Write all the files in one `write_files` call, read the check it returns,
   fix every error, then `run_tests`, then `request_deploy`.

## Pitfalls

- A handler named in `registerRoute` must be a top-level function of
  `main.ts`. Do not `export` it.
- A form posts form fields (`context.request.form`); a script's `fetch` or a
  JSON client posts a body (`context.request.json()`). Check which the request
  means, and answer 400 with `ResponseBuilder.error(400, "…")` for a bad body.
- Escape every visitor-supplied string you put in HTML with `escapeHtml`.
- A POST route needs `method: "POST"`; the default is GET.
- Two paths cannot share a route and method. If `registerRoute` answers
  `{ ok: false }`, read the reason; `init()` still has to log it.
- A list in `scriptStorage` that many people change can lose an update: keep
  the code small and read-modify-write in one handler.
- Routes are not served until the script is deployed. Test behaviour with
  `run_tests`, calling your `lib/` functions directly.
