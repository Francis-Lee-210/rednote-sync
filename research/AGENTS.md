# Research documentation instructions

These rules apply to everything under `research/` and supplement the repository-level `AGENTS.md`.

## Placement

- A study of one external repository belongs in `projects/<slug>/` with `review.md`, `provenance.json`, `checkpoint.json`, and an ignored `source/` checkout when present.
- A cross-project question belongs in `topics/`. It must link back to the project evidence it synthesizes.
- Reverse-engineering targets, reports, tools, and captured samples belong in `reverse/`.
- Do not create new project directories directly under `research/`.

## Evidence boundaries

- Every project conclusion is tied to its recorded revision and review scope. A rating is a research judgment, not a product decision or permanent prohibition.
- Preserve historical findings. Correct factual errors directly, but handle changed product intent with a scope banner and a link to current product authority.
- Qualify old Stage 1–4 references as historical implementation stages.
- Treat experiment-specific account choices, stopping conditions, and “online probing” rules as local to that experiment unless the user explicitly adopts them as product policy.
- Never claim that an account route, browser mode, delay pattern, or Cookie source is safe without direct evidence.

## Source handling

- Keep third-party checkouts under `projects/<slug>/source/` and ignored by Git.
- Do not execute, install, clean, or rewrite third-party sources during documentation work.
- Update `README.md` and `catalog.md` whenever a research project or topic is added, moved, or reclassified.
