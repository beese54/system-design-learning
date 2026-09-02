# 07 · Connections, pooling, and the N+1 you already met

In the API Design course, the compare chart showed the naive REST implementation costing **four
HTTP round trips** to render one artist page, and you learned to see that as the cost. It was
half the bill. Each of those four requests also ran queries, and nobody counted them.

This lesson counts them, and then looks at the layer underneath — the connections those queries
travel on, which is where a surprising amount of production latency hides.

---

## Part 1 · The N+1, priced

Open **Tab 6 · N+1** and run it. Three implementations of the same artist page, against the real
database:

```
N+1 (a query per album)          6 queries    16.1 ms
One join, nested in app code     1 query       4.1 ms
One query, shaped in SQL         1 query       3.7 ms
```

The N+1 version is the one that looks like good code:

```js
const artist = await db.one('SELECT * FROM artists WHERE id = $1', [id]);
const albums = await db.many('SELECT * FROM albums WHERE artist_id = $1', [id]);
for (const album of albums) {
  album.tracks = await db.many('SELECT * FROM tracks WHERE album_id = $1', [album.id]);
}
```

Nothing is wrong with any individual line. That is the whole problem: **N+1 is invisible at the
statement level and only appears when you count statements.** Four albums today is six queries.
An artist with sixty albums is sixty-two, and the loop that produced them still looks fine in
review.

This is also exactly what an ORM does by default when you traverse a relation in a loop — the
lazy-loading feature is the N+1 generator. Most ORMs offer an eager-load or `include` option; it
exists because of this lesson.

### Reading the three rows honestly

**Fewer queries is not automatically better.** The third row is the fastest and it buys that with
`jsonb_agg` and a lateral join — SQL that a colleague will have to reverse-engineer in six months.
The second row is nearly as fast, plain to read, and repeats the artist's columns on every
returned row.

The engineering answer is usually the middle one, and the reason to know all three is to
recognise which problem you have:

- **Latency-bound** (many round trips to a database over a network) → collapse to one query.
- **Bandwidth-bound** (one query returning hugely redundant columns) → shape it in SQL.
- **Neither** → leave the readable version alone.

### The index interaction

Run the tab before adding indexes, then add `tracks (album_id)` in Tab 3 and run it again. The
N+1 gets faster — but it is *still* an N+1. Indexing reduces the cost of each query; it does not
reduce the count. Round trips and per-query cost are independent problems, and fixing one does not
fix the other.

---

## Part 2 · Connections are not free

A Postgres connection is not a socket. It is a **forked backend process** on the server, with its
own memory. Measure it in **Tab 7 · Pool & cost**:

```
new connection    11.62 ms
pooled             0.91 ms      12.7× cheaper
```

Twelve milliseconds, on a database running on the same machine with no network in the way. Add a
network and TLS and it is worse. If your application opens a connection per request, you are
paying that on every request — and if your traffic doubles, you are also forking twice as many
processes on a server that has a hard `max_connections` limit.

A pool keeps connections open and lends them out. "Connect per request" becomes "borrow per
request," and the fork cost is amortised to nearly nothing.

---

## Part 3 · The pool has a floor, and it queues silently

This is the part that catches people, and it is why this tab exists.

The lab's pool holds 8 connections. Run it at concurrency 8, then at 40:

```
concurrency 8     total  67 ms    queue wait p95   14.3 ms
concurrency 40    total 267 ms    queue wait p95  213.4 ms
```

Each request did 50 ms of work in both runs. Nothing about the database got slower. But at
concurrency 40, thirty-two requests could not start until a connection freed up, and the p95
request spent **213 ms waiting to begin**.

Now think about where that time shows up. Not in `pg_stat_statements` — from Postgres' point of
view every query took 50 ms. Not in database CPU, which is idle. It appears only in your
application's response times, as latency with no visible cause.

**Slow endpoint, fast queries, idle database CPU** is the signature. When you see it, look at pool
wait time before you look at anything else. If your pool does not expose that metric, instrument
it — the time between "I want a connection" and "I have one" is one of the highest-value numbers
in a web application, and most teams do not measure it.

The arithmetic is simple enough to do in your head: with a pool of `P` and requests taking `D`,
`N` concurrent requests take about `ceil(N/P) × D`. The lab prints its prediction next to the
measurement so you can watch the model hold.

### Sizing

The instinct is to raise the pool until the queue disappears. That moves the queue rather than
removing it: past the point where the server has spare cores and disk, more concurrent queries
just means each one runs slower.

- Start near **cores × 2**, then measure under real load.
- Remember pools are **per process**. Ten pods with a pool of 20 is 200 connections. Compare that
  with `max_connections` (shown in the tab) *before* you scale out.
- If you genuinely need hundreds of application instances, put **PgBouncer** in front in
  transaction-pooling mode. It multiplexes many client connections onto few server ones — at the
  cost of session state: no session-level `SET`, no advisory locks, prepared statements need care.
- **Fix the slow queries first.** A pool exhausted by queries that should take 2 ms and take 200
  is not a pool-sizing problem.

### The one that takes the whole site down

A connection held by an `idle in transaction` session is out of the pool *and* holding locks *and*
pinning the oldest snapshot. Combine that with the previous lesson's advice and you get the rule:

> **Never hold a database connection across a call to something you do not control.**

Fetch what you need, close the transaction, *then* call the payment provider. A third-party
timeout should cost you one request, not your entire pool.

---

## What you should now be able to do

- [ ] Spot the N+1 shape in ordinary-looking code, and count the statements a request issues.
- [ ] Choose between N+1, one join, and shaping in SQL — and justify not always picking the fastest.
- [ ] Explain why indexing an N+1 does not fix the N+1.
- [ ] Say what a connection costs and why, in terms of what the server actually creates.
- [ ] Predict the latency of `N` concurrent requests against a pool of `P`.
- [ ] Recognise the "slow endpoint, fast queries, idle CPU" signature and know where to look.
- [ ] Size a pool, accounting for every process that has one.

**Artifact for this module:** a **pool sizing note** for a real service. State its instance count,
pool size per instance, the resulting total, and the server's `max_connections` — then say whether
those numbers are safe and what happens during a deploy when old and new instances overlap. Add
the p95 pool wait time if you can measure it, or "not currently measured" if you cannot; naming
the gap is a legitimate finding, and usually the most valuable line in the note.

Next: [08 · Scaling one node](08-scaling-one-node.md)
