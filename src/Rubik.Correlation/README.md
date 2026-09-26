# Rubik correlation

`FileChangeGrouper` accepts only configured roots, rejects reparse points, and coalesces repeated notifications for the same path during an 800 ms default window. Flush pending observations when their window expires or when the session closes. The resulting `file.detected` record contains path/size/hash/change-kind metadata and explicitly states `semantic_change=false`; do not translate a binary hash difference into a property-change statement.

`TemporalCorrelator.Group` deterministically groups source event IDs by session and temporal gap/duration and links their artifact references. The summary is deliberately cautious; groups are not semantic interpretations. Inferred source events retain their own provenance and confidence. Correlation output confidence is a heuristic for grouping only, and uncertainty strings identify absent artifacts or file-only evidence.
