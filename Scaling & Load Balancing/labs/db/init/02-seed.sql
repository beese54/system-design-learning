-- Deterministic, and deliberately small.
--
-- Course 2 seeded a million plays because the lesson was "at this size the
-- planner's choice matters". This course does not need that: the database is
-- here to be a shared state store and a source of a few milliseconds of honest
-- I/O wait, not to be the subject. A light seed means `docker compose up`
-- finishes in seconds, which matters when the chapter asks you to reset the
-- lab repeatedly.
--
-- Volumes: 3 + 197 artists, 800 albums, 8,000 tracks, 50,000 plays.

SELECT setseed(0.42);

-- The three artists from Course 1 keep their ids. Every course in this series
-- uses the same domain so that any difference you measure is a design
-- difference, not a domain difference.
INSERT INTO artists (id, name, country) VALUES
  ('a1', 'Rival Consoles',  'GB'),
  ('a2', 'Nils Frahm',      'DE'),
  ('a3', 'Floating Points', 'GB');

INSERT INTO artists (id, name, country)
SELECT 'a' || (n + 3),
       'Artist ' || (n + 3),
       (ARRAY['GB','DE','US','JP','BR','NG','SE'])[1 + (n % 7)]
  FROM generate_series(1, 197) AS n;

INSERT INTO albums (id, artist_id, title, year)
SELECT 'al' || row_number() OVER (ORDER BY a.id, s.n),
       a.id,
       'Album ' || s.n || ' by ' || a.name,
       1990 + ((s.n * 7) % 35)
  FROM artists a
  CROSS JOIN generate_series(1, 4) AS s(n);

INSERT INTO tracks (id, album_id, title, seconds)
SELECT 't' || row_number() OVER (ORDER BY al.id, s.n),
       al.id,
       'Track ' || s.n,
       120 + ((s.n * 37) % 300)
  FROM albums al
  CROSS JOIN generate_series(1, 10) AS s(n);

-- Skewed on purpose: a handful of tracks carry most of the plays, because
-- uniform data makes every measurement boring and unlike production.
--
-- Track ids are t1..t8000 in insertion order, so squaring a uniform random
-- gives a cheap skew toward the low ids without a per-row sort. The obvious
-- "ORDER BY random() LIMIT 1" formulation sorts every track for every play -
-- 50,000 sorts of 8,000 rows - and turns an 8-second seed into a coffee break.
INSERT INTO plays (track_id, played_at, ms_played)
SELECT 't' || (1 + (power(random(), 2) * 7999)::int),
       now() - (random() * interval '90 days'),
       60000 + (random() * 180000)::int
  FROM generate_series(1, 50000);

-- Not optional after a bulk load: without this the planner is working from
-- statistics that describe an empty database.
ANALYZE;

DO $$
DECLARE p bigint; t bigint;
BEGIN
  SELECT count(*) INTO p FROM plays;
  SELECT count(*) INTO t FROM tracks;
  RAISE NOTICE 'Fleet lab seeded: % plays over % tracks', p, t;
END $$;

-- The seed's finish line.
--
-- This table exists ONLY after everything above has committed, which is what
-- makes it a trustworthy readiness signal. The compose healthcheck reads it,
-- and so does the lab's own probe - a health check that reports ready before
-- the thing is usable is the exact failure this course spends Lesson 05 on.
CREATE TABLE lab_ready (seeded_at timestamptz NOT NULL DEFAULT now());
INSERT INTO lab_ready DEFAULT VALUES;
