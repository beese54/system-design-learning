-- Chapter III schema: a shared state store for a fleet of app instances.
--
-- READ THIS IF YOU CAME FROM COURSE 2: that schema was deliberately
-- UNDER-indexed, because the course was about learning to see a missing index.
-- This one is indexed properly and on purpose. Course 3 is about the tier
-- ABOVE the database, and an accidentally slow query here would contaminate
-- every scaling measurement in the chapter. If a number in this course moves,
-- it should be because you changed the number of instances - not because
-- Postgres chose a sequential scan.
--
-- Two groups of tables:
--   the catalogue  - the same music domain as Courses 1 and 2, and the source
--                    of honest I/O wait for the `io` work mode
--   the state      - sessions and play queues: the things that must NOT live
--                    inside a single app process, which is what Lessons 03 and
--                    07 are about

BEGIN;

-- ----------------------------------------------------------------- catalogue
CREATE TABLE artists (
  id      text PRIMARY KEY,
  name    text NOT NULL,
  country text NOT NULL
);

CREATE TABLE albums (
  id        text PRIMARY KEY,
  artist_id text NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title     text NOT NULL,
  year      int  NOT NULL CHECK (year BETWEEN 1900 AND 2100)
);
-- Postgres does not index foreign keys for you (Course 2, Lesson 02).
CREATE INDEX idx_albums_artist ON albums (artist_id);

CREATE TABLE tracks (
  id       text PRIMARY KEY,
  album_id text NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  title    text NOT NULL,
  seconds  int  NOT NULL CHECK (seconds > 0)
);
CREATE INDEX idx_tracks_album ON tracks (album_id);

CREATE TABLE plays (
  id         bigserial PRIMARY KEY,
  track_id   text        NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at  timestamptz NOT NULL,
  ms_played  int         NOT NULL
);
-- Equality column first, range column last - the rule from Course 2, Lesson 04.
CREATE INDEX idx_plays_track_time ON plays (track_id, played_at);

-- --------------------------------------------------------------------- state
-- A session is the canonical thing people wrongly keep in process memory.
-- `served_by` is not something a real application would store; it is lab
-- instrumentation, so the Balancer and Stickiness tabs can show you which
-- instance handled which request without guessing.
CREATE TABLE sessions (
  id         text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  served_by  text,
  hits       int NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_last_seen ON sessions (last_seen);

-- A play queue is state with consequences. Losing a session is an annoyance;
-- losing the queue someone spent ten minutes building is a lost user. Lesson 03
-- uses this table to make the statelessness argument concrete rather than
-- theoretical, and Tab 5 measures what it costs to move it here.
--
-- It is a play queue rather than a shopping cart on purpose: every course in
-- this series stays inside the music domain, so a difference you measure is
-- never just a difference of subject.
CREATE TABLE play_queues (
  session_id text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  tracks     jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- One query, shaped in SQL, for the `io` work mode. It lives here rather than
-- in the application so that every instance runs byte-identical work - if the
-- instances did not all do exactly the same thing, comparing them would be
-- meaningless.
CREATE VIEW artist_pages AS
SELECT a.id   AS artist_id,
       a.name AS artist_name,
       count(DISTINCT al.id) AS albums,
       count(DISTINCT t.id)  AS tracks
  FROM artists a
  LEFT JOIN albums al ON al.artist_id = a.id
  LEFT JOIN tracks t  ON t.album_id  = al.id
 GROUP BY a.id, a.name;
