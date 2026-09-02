-- ---------------------------------------------------------------------------
-- The seed. Runs once, on first `docker compose up`, in about 30-60 seconds.
--
-- Scale is the whole point. 500 artists / 2,000 albums / 22,000 tracks is
-- ordinary; the million rows in `plays` are what make an index worth having
-- and a sequential scan worth avoiding. Everything is generated with a fixed
-- random seed, so your row counts and your EXPLAIN numbers match the lessons.
-- ---------------------------------------------------------------------------

SELECT setseed(0.42);

-- The three artists from the API Design course, ids intact. Everything you
-- learned to query over HTTP in Course 1 is still here, now on real storage.
INSERT INTO artists (id, name, country, formed, bio) VALUES
  ('a1', 'Nova Kim',     'KR', 2016, 'Synth-pop producer working out of Seoul. Known for building songs live from field recordings.'),
  ('a2', 'The Long Way', 'IE', 2009, 'Four-piece from Galway. Two decent records, one great one, and a reputation for very long sets.'),
  ('a3', 'Ama Boateng',  'GH', 2019, 'Highlife guitarist and arranger. Records everything to tape, mixes everything in the box.');

-- 497 more, so that "find the artist" is a real lookup rather than a glance.
INSERT INTO artists (id, name, country, formed, bio)
SELECT 'a' || g,
       (ARRAY['Velvet','Paper','Neon','Quiet','Northern','Amber','Hollow','Slow','Bright','Iron',
              'Salt','Ember','Glass','Wild','Low'])[1 + floor(random() * 15)::int]
         || ' ' ||
       (ARRAY['Hours','Harbour','Signal','Weather','Machines','Gardens','Static','Union','Country','Motion',
              'Radio','Anthem','Divide','Chorus','Season'])[1 + floor(random() * 15)::int],
       (ARRAY['US','GB','KR','IE','GH','JP','BR','DE','NG','SE'])[1 + floor(random() * 10)::int],
       2000 + floor(random() * 25)::int,
       NULL
  FROM generate_series(4, 500) g;

-- Four albums each. ORDER BY in the window makes the ids deterministic, so
-- 'b1' is always Nova Kim's first record on every machine.
INSERT INTO albums (id, artist_id, title, year, label)
SELECT 'b' || row_number() OVER (ORDER BY a.id, n),
       a.id,
       (ARRAY['Small Machines','After the Signal','Tape Hiss','The Quiet Part','Harbour Lights',
              'Second Language','Nightshift','Paper Boats','Open Water','Long Division'])[1 + floor(random() * 10)::int],
       a.formed + n + floor(random() * 3)::int,
       (ARRAY['Coldwater','Fieldnote','Tin Roof','Northline',NULL])[1 + floor(random() * 5)::int]
  FROM artists a
  CROSS JOIN generate_series(1, 4) n;

-- Eleven tracks per album. The UNIQUE (album_id, position) constraint from the
-- schema is what stops `n` from ever colliding.
INSERT INTO tracks (id, album_id, title, seconds, position)
SELECT 't' || row_number() OVER (ORDER BY b.id, n),
       b.id,
       (ARRAY['Cold Open','Ghost Note','Half Light','Undertow','Second Wind','Carbon','Slow Exit',
              'Field Recording','Blue Hour','Reprise','Hold Steady'])[n],
       120 + floor(random() * 240)::int,
       n
  FROM albums b
  CROSS JOIN generate_series(1, 11) n;

INSERT INTO listeners (handle, country, created_at)
SELECT 'listener_' || g,
       (ARRAY['US','GB','KR','IE','GH','JP','BR','DE','NG','SE'])[1 + floor(random() * 10)::int],
       now() - (random() * 720) * interval '1 day'
  FROM generate_series(1, 50000) g;

-- One million plays. Track and listener ids are contiguous by construction
-- ('t1'..'t22000', 1..50000), so we can synthesise a reference instead of
-- looking one up per row - the difference between 8 seconds and an hour.
--
-- power(random(), 2) skews plays toward low-numbered tracks, which is what
-- real listening looks like: a short head, a very long tail. A uniform
-- distribution would make every "top tracks" query boring and every index
-- look equally useful.
INSERT INTO plays (track_id, listener_id, played_at, ms_played, device)
SELECT 't' || (1 + floor(power(random(), 2) * 22000)::int),
       1 + floor(random() * 50000)::bigint,
       now() - (random() * 365) * interval '1 day',
       30000 + floor(random() * 240000)::int,
       (ARRAY['phone','desktop','speaker','car'])[1 + floor(random() * 4)::int]
  FROM generate_series(1, 1000000);

-- Lab 4, write skew. The rule says at least one album must stay featured;
-- exactly two are featured now, which is what makes the anomaly possible.
INSERT INTO editorial_rules (rule, min_value) VALUES ('min_featured_albums', 1);
UPDATE albums SET is_featured = true WHERE id IN ('b1', 'b2');

-- Without this the planner is working from empty statistics and every plan you
-- read in Lab 2 would be a lie. ANALYZE is not optional after a bulk load.
ANALYZE;

DO $$
DECLARE n_plays bigint;
BEGIN
  SELECT count(*) INTO n_plays FROM plays;
  RAISE NOTICE 'Storage lab seeded: % plays across 22000 tracks, 2000 albums, 500 artists.', n_plays;
END $$;

-- The seed's finish line.
--
-- This table exists ONLY after everything above has committed, which makes it
-- a reliable "is the lab ready" signal. The obvious healthcheck - querying
-- plays - is not reliable: the table exists from the moment 01-schema.sql
-- runs, and an empty result is still a successful query, so a healthcheck
-- built on it reports healthy while the seed is still inserting.
CREATE TABLE lab_ready (seeded_at timestamptz NOT NULL DEFAULT now());
INSERT INTO lab_ready DEFAULT VALUES;
