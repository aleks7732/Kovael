# NEXT-PROMPT

> The always-current handoff. Refreshed at the end of every working session
> so the next session — yours or a sister-instance's — can pick up cleanly.
> If this file is stale, the resume isn't trustworthy; rewrite before
> dispatching anything.

## Where we stopped

Scaffolded the nyx dev-loop infrastructure in two pilot-orchestrated waves (6 subagent dispatches total). Wave 1 created the user-level template canon at `~/.claude/templates/nyx-loop/` (5 files) and designed project-level note drafts. Wave 2 installed `.claude/notes/` (local-only per repo `.gitignore` policy), `NEXT-PROMPT.md` (this file, tracked), and `CLAUDE.md` (tracked, pointer doc, 58 LOC). The B3 caveman:cavecrew-reviewer subagent reviewed all artifacts — 1 medium finding fixed inline, otherwise clean. Two strategy + two delta notes landed at `.claude/notes/2026-05-23_*.md`.

## What's next

- Decide: `git add CLAUDE.md NEXT-PROMPT.md` + commit + PR — or leave untracked for further iteration.
- If committing: write a commit message referencing the wave delta notes (which won't be in the diff since `.claude/` is gitignored).
- Optional: audit-revert B1's global `git config --global --add safe.directory ...` change if undesired (see wave-2 delta D12).
- Optional: write a memory-learning episode capturing the doubled-scope pilot pattern (6 dispatches across 2 waves with notes loop) as a reusable workflow.

## Files in flight

- `CLAUDE.md` — untracked, ready for `git add`
- `NEXT-PROMPT.md` — this file, untracked, ready for `git add`
- `.claude/notes/2026-05-23_wave-{1,2}-{strategy,delta}.md` — local-only, not committed
- `.claude/notes/README.md`, `.claude/notes/filename-convention.md` — local-only, not committed
- `~/.claude/templates/nyx-loop/*.md` — user-level canon, 5 files, outside worktree

## Open questions

- Should `NEXT-PROMPT.md` be committed every session-end, or only when materially changed?
- Are the user-level templates the right canon, or do they need migration to a different location (e.g., a plugin)?
- Does the team want `.claude/notes/` ever made trackable, or is local-only the durable policy?

## Resume command

Start the next session with: read `.claude/notes/2026-05-23_wave-2-delta.md` first, then `CLAUDE.md`, then decide whether to commit the tracked files or keep iterating.
