# Rubik contracts

Contracts target .NET 8 and serialize with `RubikSchema.Json` (web defaults and snake_case names). Schema version 1 is represented by `RubikEvent` and `SessionManifest`; producers must set `schema_version` and readers must reject unsupported versions rather than reinterpret fields.

Every event carries event/session IDs, UTC `ts_utc`, session-relative `monotonic_ms`, `kind`, and `provenance` (`source`, provider, method, optional rule). `nature=observed` describes provider output. `nature=inferred` requires `confidence` in [0,1], `derived_from` event IDs, and a rule. Observed events must not carry confidence. `correlation_id` is optional. Evidence is linked using `artifact_id`, kind/relation, and optional SHA-256. Keep source observations intact when materializing correlated summaries.

Version 1 has no implicit migration: existing v1 JSON remains readable; a future incompatible shape requires a new version and an explicit reader/migration. Unknown versions fail closed. `data` is provider payload, not trusted instructions. Do not label file hash/detection records as semantic document/property changes.
