# Rednote Sync agent instructions

## Start here

- Preserve unrelated and uncommitted work. Never reset, discard, or silently replace existing changes.
- Start with [docs/README.md](docs/README.md) for authority and [docs/design/roadmap.md](docs/design/roadmap.md) for current status. Use [HANDOFF.md](HANDOFF.md) to choose task-specific reading.
- Before editing anything under `docs/`, read `docs/AGENTS.md` completely.
- Before editing anything under `research/`, read `research/AGENTS.md` completely.
- Scope searches to the relevant directories and honor [`.gitignore`](.gitignore) and [`.rgignore`](.rgignore). Read Core specifications, research, history, explorations, and learning material only when the task needs them.

## Documentation rules

- Classify material before writing: current authority, implemented contract, concept draft, exploration, history, research evidence, or learning material.
- Product decisions require explicit user confirmation. Research findings and agent recommendations remain evidence or exploration until then.
- Do not copy the complete current design into handoffs, indexes, research reports, or project READMEs. Link to the canonical document instead.
- Always qualify the old Stage 1–4 sequence as the **historical implementation stages**. Unqualified “Stage 1”, “Stage 2”, or similar wording refers to the current product stages only.
- Keep current status in `docs/design/roadmap.md`; do not turn a dated research progress record into the current roadmap.
- When moving or renaming documentation, update every relative Markdown/HTML link, catalog entry, and README in the same change.
- Prefer a status banner and an authority link over rewriting historical evidence.

## Safety and verification

- Treat cookies, tokens, browser profiles, storage state, HAR files, and local third-party checkouts as sensitive material. Do not read or expose them unless the user explicitly requests it.
- Never run third-party research copies merely to update documentation.
- Before finishing a documentation change, check local links, JSON metadata, ignore rules, `git diff --check`, and `git status --short`.
- Do not commit or publish changes unless the user explicitly asks.
