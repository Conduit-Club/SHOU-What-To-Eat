-- Existing and anonymous submissions retain moderator approval. Eligibility
-- is captured only from the verified session when a new submission is created.
ALTER TABLE submissions ADD COLUMN submitter_user_id INTEGER REFERENCES auth_users(id);
ALTER TABLE submissions ADD COLUMN publication_mode TEXT NOT NULL DEFAULT 'moderated'
  CHECK (publication_mode IN ('moderated', 'direct'));
ALTER TABLE submissions ADD COLUMN public_author_alias TEXT
  CHECK (public_author_alias IS NULL OR length(public_author_alias) BETWEEN 2 AND 24);
CREATE INDEX submissions_submitter_idx ON submissions(submitter_user_id, created_at)
  WHERE submitter_user_id IS NOT NULL;
