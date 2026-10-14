# Contributing

How the agent works and why it is shaped as it is: [README.md](README.md). The
engine it runs on, and the rules for changing it:
[aiwebengine](https://github.com/lpajunen/aiwebengine/blob/main/CONTRIBUTING.md).

## Before a change

1. For anything larger than a fix, open an issue first and say what you intend.
2. Branch from `main`.
3. The scripts need the engine script API named in `.aiwebengine-requires`. A
   change that needs a newer engine moves that date.
4. A change to the agent's tools or prompts comes with the `eval/` tasks that
   measure it ([eval/README.md](eval/README.md)).

## Before a pull request

```bash
npx tsc -p tsconfig.json     # typecheck against types/aiwebengine.d.ts
```

- Install the changed scripts on an engine (`pull_from_git`) and try them
  there; the README says how.
- Update the README where the change makes it untrue. It describes what is
  true now; history belongs in the commit message.
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `refactor:`,
  `test:`, `docs:`, `perf:`, `chore:`, with `!` for a breaking change. A pull
  request is squash-merged with its title as the commit message.

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at
your option. Unless you say otherwise, a contribution you submit is licensed
the same way, with no additional terms.

## Security

Report vulnerabilities privately as described in the engine's
[SECURITY.md](https://github.com/lpajunen/aiwebengine/blob/main/SECURITY.md),
not in a public issue.
