## Change

Describe the problem and resulting behavior.

## Bug triage (when applicable)

For each bug, record likelihood (1–10), impact (1–10), evidence and uncertainty, fix regression risk, and the fix/defer decision. Scores inform judgment; a low product never overrides memory integrity, identity/namespace isolation, authorization, duplicate external actions or supported-workflow failures. Link an issue and revisit trigger for deferred findings.

- [ ] Release validation stays within the agreed scope; unrelated improvements are deferred unless a demonstrated release blocker or an approved scope change requires them.

## Compatibility and validation

- [ ] Existing defaults and supported workflow/store versions remain compatible, or an explicit migration is documented.
- [ ] Bug fixes include a permanent reproducer; opt-in features cover the unchanged default path.
- [ ] Storage changes preserve existing record IDs, episode chains, source evidence and governance decisions.
- [ ] Relevant embedded, actual Neo4j and packaged native n8n checks pass.
- [ ] Existing test expectations were not weakened to hide a failure. Any deliberate behavior changes are explained.
- [ ] Required checks pass; gated provider checks and remaining limitations are stated.

Validation and any activation/rollback requirements:
