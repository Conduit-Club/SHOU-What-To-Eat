-- New contributions capture an explicitly chosen public identity once. Existing
-- drafts and public records retain their original authors and unknown dates.
ALTER TABLE submissions ADD COLUMN public_identity_recorded INTEGER NOT NULL DEFAULT 0
  CHECK (public_identity_recorded IN (0, 1));
ALTER TABLE submissions ADD COLUMN public_author_avatar TEXT
  CHECK (public_author_avatar IS NULL OR (length(public_author_avatar) <= 2000 AND public_author_alias IS NOT NULL));
