# Public source guides

Edit `ai-ml.md` beside the discovery instructions, or supply it in
`NEWSLETTER_DISCOVERY_DIR/_sources/ai-ml.md` when mounting a custom directory.
It is an optional navigation guide for `01-ai-ml`, not another worker or a network
allowlist. Custom instruction directories without a guide remain compatible.

The service reads it only while accepting a new run, appends its exact text to
that direction, and hashes/persists the combined instruction. Editing the guide
does not change queued runs, retries, frozen evidence or previous emails. No
credentials or private information belong in this public file. Symlinks, invalid
UTF-8 and files over 16 KB are rejected; the combined instruction stays under 24 KB.

Candidate source fields are optional for old public inputs: `authors`,
`affiliations`, `venue`, `publication_status`, `contribution`, `source_basis` and
`evidence_urls`. Unknown strings are empty; the URL list is bounded to four.
New discovery checks that each evidence URL was actually opened. This is a
provenance boundary, not automatic verification of author identities, acceptance
status or scientific importance. Those claims still require source-grounded review.
