-- Identity key for per-user unique saved establishments.
-- Strategy (documented in searchEngine.leadIdentityKey):
--   phone (>=8 digits) → p:<digits>
--   else name+address  → na:<name>|<addr48>
--   else name only     → n:<name>
-- Historical duplicates: keep the earliest row's identity_key; null the rest so UNIQUE can be created safely.

ALTER TABLE saved_leads
  ADD COLUMN IF NOT EXISTS identity_key TEXT;

-- Backfill phone-based keys
UPDATE saved_leads
SET identity_key = 'p:' || regexp_replace(phone, '\D', '', 'g')
WHERE identity_key IS NULL
  AND phone IS NOT NULL
  AND length(regexp_replace(phone, '\D', '', 'g')) >= 8;

-- Backfill name+address when still null
UPDATE saved_leads
SET identity_key = 'na:' ||
  lower(regexp_replace(coalesce(name, ''), '[^a-zA-Z0-9]+', ' ', 'g')) || '|' ||
  left(lower(regexp_replace(coalesce(address, ''), '[^a-zA-Z0-9]+', ' ', 'g')), 48)
WHERE identity_key IS NULL
  AND name IS NOT NULL
  AND address IS NOT NULL
  AND length(trim(address)) >= 4;

-- Name-only fallback
UPDATE saved_leads
SET identity_key = 'n:' || lower(regexp_replace(coalesce(name, ''), '[^a-zA-Z0-9]+', ' ', 'g'))
WHERE identity_key IS NULL
  AND name IS NOT NULL
  AND length(trim(name)) >= 4;

-- Resolve historical duplicates: keep earliest created_at per (user_id, identity_key)
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, identity_key
           ORDER BY created_at ASC NULLS LAST, id ASC
         ) AS rn
  FROM saved_leads
  WHERE identity_key IS NOT NULL
)
UPDATE saved_leads sl
SET identity_key = NULL
FROM ranked r
WHERE sl.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS saved_leads_user_identity_uidx
  ON saved_leads (user_id, identity_key)
  WHERE identity_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS saved_leads_identity_key_idx
  ON saved_leads (identity_key)
  WHERE identity_key IS NOT NULL;
