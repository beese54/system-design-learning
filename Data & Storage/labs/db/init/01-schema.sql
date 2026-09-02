-- ---------------------------------------------------------------------------
-- The catalogue, now with real storage underneath it.
--
-- This is the same domain as the API Design course - artists, albums, tracks -
-- plus the two tables that make it a storage problem rather than a toy:
-- listeners, and one row per play. The API course served 3 artists from an
-- array in memory. Here the same three artists sit on top of a million plays,
-- which is the point: at 3 rows every plan is a sequential scan and every
-- index is a waste of disk. Storage only starts teaching at scale.
--
-- READ THIS BEFORE LESSON 04: this schema is DELIBERATELY UNDER-INDEXED.
-- Primary keys and unique constraints get indexes automatically. Foreign keys
-- DO NOT - Postgres never indexes a foreign key for you, which is one of the
-- most common causes of a slow production database. Lab tab 3 has you add the
-- missing indexes yourself and watch the plans change.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE artists (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  country     char(2) NOT NULL,
  formed      int  NOT NULL CHECK (formed BETWEEN 1900 AND 2100),
  bio         text,
  -- A constraint is a promise the database keeps even when your application
  -- code is wrong, which it eventually will be. This is why constraints live
  -- here and not only in the API validation layer.
  CONSTRAINT artists_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE albums (
  id          text PRIMARY KEY,
  artist_id   text NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title       text NOT NULL,
  year        int  NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  label       text,
  is_featured boolean NOT NULL DEFAULT false
);

CREATE TABLE tracks (
  id          text PRIMARY KEY,
  album_id    text NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  title       text NOT NULL,
  seconds     int  NOT NULL CHECK (seconds > 0),
  position    int  NOT NULL,
  -- Two tracks cannot occupy the same slot on the same album. Expressing this
  -- as a UNIQUE constraint means it is true forever, not just true in the code
  -- path you remembered to guard.
  UNIQUE (album_id, position)
);

CREATE TABLE listeners (
  id          bigserial PRIMARY KEY,
  handle      text NOT NULL UNIQUE,
  country     char(2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The big one. One row every time somebody plays a track.
-- No index on track_id, no index on played_at, no index on listener_id.
-- That is not an oversight - it is Lab 3's starting position.
CREATE TABLE plays (
  id           bigserial PRIMARY KEY,
  track_id     text NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  listener_id  bigint NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
  played_at    timestamptz NOT NULL,
  ms_played    int NOT NULL CHECK (ms_played >= 0),
  device       text NOT NULL CHECK (device IN ('phone','desktop','speaker','car'))
);

-- Used only by the write-skew scenario in Lab 4. Small on purpose: the
-- anomaly it demonstrates has nothing to do with size.
CREATE TABLE editorial_rules (
  rule        text PRIMARY KEY,
  min_value   int  NOT NULL
);

COMMIT;

-- A view the N+1 lab uses, so the "one query" version stays readable.
CREATE VIEW artist_pages AS
  SELECT a.id AS artist_id, a.name, a.country,
         b.id AS album_id, b.title AS album_title, b.year,
         t.id AS track_id, t.title AS track_title, t.seconds, t.position
    FROM artists a
    JOIN albums  b ON b.artist_id = a.id
    JOIN tracks  t ON t.album_id  = b.id;
