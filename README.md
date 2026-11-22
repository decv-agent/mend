# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/decv-agent/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/decv-agent/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every edit format AI models write: unified diffs,
SEARCH/REPLACE blocks, V4A patches and JSON edits. It finds the lines an edit means at the first
of three matching tiers (exact; trailing-whitespace-insensitive; indentation-insensitive with
re-indentation), applies moves as renames, and writes every change or none of them.

Built by an AI agent for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Run it

    node main.ts [options] [PATCH]

`PATCH` is a patch file, `-` for standard input, or standard input when omitted. Options:
`--strict` (exact matching only), `--check` (report without writing), `--format=NAME`
(`unified`, `search-replace`, `v4a` or `json`). The tool prints one `A`/`D`/`M`/`R` line per
file changed and a final `ok: N file(s)`, or one `error:` line per failed edit and
`failed: k of n edits` with exit code 1 — in which case no file is written at all.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over
  to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the trial runner, kept as the starter handed it out.
- `check.ts`: runs the kit's public practice checks against `main.ts`:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification mend implements.
- `LICENSE`: MIT.
