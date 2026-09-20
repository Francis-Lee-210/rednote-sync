# Product documentation instructions

These rules apply to everything under `docs/` and supplement the repository-level `AGENTS.md`.

## Authority states

- **Current authority**: confirmed product purpose, stages, status, and boundaries. Only explicit user decisions may change these documents.
- **Implemented contract**: behavior already implemented in a project. Keep it in that project’s README or `docs/`; product documents may link to it but must not redefine it.
- **Concept draft**: shared vocabulary for future work. It must list its non-decisions and must not look implementable.
- **Exploration**: a candidate architecture, model, or workflow. Evidence and recommendations are allowed; adoption claims are not.
- **History**: dated context that preserves what was believed or built earlier. It is never the current roadmap.

## Placement

- Put stable purpose in `mission.md`, confirmed product behavior in `design/product-design.md`, and current status or open questions in `design/roadmap.md`.
- Put unconfirmed proposals in `explorations/`, dated superseded material in `history/`, and accepted documentation-structure decisions in `decisions/`.
- Keep Core runtime and protocol truth under `projects/docs/`; `projects/` is the current single-package root.
- Use the terms defined in `glossary.md`. Distinguish current product stages from historical implementation stages every time both could be confused.

## Change discipline

- Do not promote research ratings, experimental constraints, or safety hypotheses into product requirements.
- Do not describe an exploration as “confirmed”, “recommended implementation”, or “current architecture” without a user decision.
- If a product question is unresolved, state what is known and list the non-decisions; do not fill the gap with an agent assumption.
- Keep indexes short and task-oriented. They should explain where to read next, not duplicate the target document.
