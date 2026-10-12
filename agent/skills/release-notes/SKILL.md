---
name: release-notes
description: Generate release notes by reading recent commits, grouping by user-facing changes rather than files, and ending with action items.
hosts: api.github.com
---

## When to use

The user asks for release notes, a changelog, what's new, or what changed
recently.

## What to do

1. Read the recent commit history — the last 10-20 commits, or everything
   since the last tag.
2. Group the commits by **user-facing feature or fix**, not by file.
   - Look for what the change does for the person using it, not how it was
     implemented.
   - Combine related commits under one heading when they address one feature.
   - Examples: "Performance improvements", "New login method", "Bug fixes in
     export".
3. For each group, write one or two sentences on what changed and why it
   matters.
4. Finish with a single line on anything that needs action — migrations,
   deprecations, new setup steps, breaking changes. If there is nothing, say
   "No action required".

## Where the commits come from

This agent has no shell, so `git log` is not available to it. Use the GitHub
API through `run_js` instead, for example
`https://api.github.com/repos/<owner>/<repo>/commits?per_page=20`, and send a
`user-agent` header or GitHub refuses the request. A private repository needs
a token, which this agent does not hold — ask for the commits to be pasted in
instead.

## Gotchas

- Do not list commits verbatim; that is not useful. Group and rewrite them so
  they read as impact.
- Read commit bodies, not just subjects — the reason for a change is usually
  in the body.
- Group commits that solve one problem even when they touch unrelated files.
- Be honest about what is new: a pure refactor is worth a line or nothing at
  all, unless it changes something a person would notice.
