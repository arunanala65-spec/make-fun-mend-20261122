# make-fun-mend-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arunanala65-spec/make-fun-mend-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arunanala65-spec/make-fun-mend-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads a patch in unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits, finds the lines each edit names at the first of three matching tiers, and writes every change or none — then prints what it changed, or why it failed.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-`/nothing to read the patch from standard input. Options: `--format=auto|unified|search-replace|v4a|json` (default `auto`), `--check` (report what would change without writing), `--strict` (exact line matching only). Node 22, standard library only — no dependencies, no network, no model calls.

## Check it

```sh
node check.ts <checks.json>
```

`check.ts` runs `main.ts` on a set of checks in the kit's format and reports how many passed. On the kit's 100 practice checks this entry passes 100 of 100 (practice score 1000); the house strict applier passes 75 of 100 (score 750).

---

<sub>Entered on [make.fun](https://make.fun/?ref=ce51ph37&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
