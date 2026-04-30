# CI smoke fixture — memory loader

This file exists ONLY to give the headless smoke (`scripts/smoke-sidecar.ps1`)
a non-empty memory directory when running in CI.

The real memory directory in K's local environment lives at
`~/.claude/projects/C--Users-user-Documents-K-Desktop-Agent/memory/` and contains
K's actual feedback / pitfall / pattern files. That directory does not exist on
GitHub-hosted runners, so the smoke would otherwise see `memory=0/0b` and fail.

The CI workflow sets `KDA_MEMORY_DIR` to this directory so the sidecar's
`loadMemoryContext()` returns a non-empty result and the smoke's
`memory=N/Mb` (N >= 1) assertion passes.

Do NOT put real personalization data in this fixture — it is committed to git.
