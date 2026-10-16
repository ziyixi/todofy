-- The Mailbox's one-sentence brief of each summarised mail (docs/todoist-plus.md, "Mailbox"; the data-layer
-- design's `headline`). Additive: the release before neither reads nor writes it, so CI may apply this before the
-- deploy and a code rollback leaves it idle. Adding a column rewrites no row; its CHECK reads each existing row
-- once, while the migration runs.
--
-- NULL: never derived. A completed summary stores the brief its first line gives (core/mailbox.brief_of, no model
-- call), so only the mail summarised before this release has none; the one-time backfill (runtime/mail_briefs.py)
-- asks the model for each of those still in the Mailbox and stores its answer here. Empty: derived, and none found
-- (the Mailbox shows the title alone). Never mail text beyond this one sentence; it goes with its summaries row.
ALTER TABLE summaries ADD COLUMN brief TEXT CHECK (brief IS NULL OR length(brief) <= 60);
