# 01 · Why storage is the hard part

In the API Design course you built three contracts over the same music catalogue and measured
what each one cost. The compare benchmark counted round trips and payload bytes, and one column
in that table was quietly lying to you: the datastore.

Every one of those API calls ended in a read. The lab served them from a JavaScript array, so
each read cost nothing and the benchmark treated storage as free. It is not free. In a real
system it is usually the largest single term in your latency budget, and it is the term that
does not get better when you add servers.

This course opens that box.

---

## Why storage resists the tricks that work everywhere else

Stateless things are easy to scale. If your API service is slow you run more copies of it. Any
request can go to any copy, because no copy knows anything the others do not. This is why the
architecture diagrams in Lesson 02 of the API course had that reassuring row of identical boxes.

Storage cannot do that, because storage is the part that *remembers*. The moment you run two
copies you have to answer questions with no comfortable answers:

- If a write lands on copy A and a read goes to copy B a millisecond later, what does the reader
  see? The old value, the new one, or an error?
- If A and B both accept a write to the same row at the same time, which one wins?
- If the network between A and B fails, do you stop serving writes, or keep serving them and
  reconcile later?

Those questions have no universally right answers — only trade-offs with names, which the rest
of this course gives you. But notice what has already happened: your stateless service scaled by
adding boxes, and your database scaled by making you choose what you are willing to lose.

That is the first reason storage is hard. Here is the second, and it is the one that will
actually bite you this year.

---

## The cost you cannot see from the API

An API contract tells a client what it can ask for. It says nothing about what answering costs.
Two endpoints with identical contracts, identical payloads and identical response times on your
laptop can differ by three orders of magnitude in production, because one of them reads twelve
rows through an index and the other reads a million rows and throws away 999,988 of them.

You measured that gap in this course's lab before you read this sentence, or you will in Lesson
03. Here it is, from the real database you are running:

```
SELECT count(*) FROM plays WHERE track_id = 't5';

  without an index    20.2 ms    36,372 blocks read    998,379 rows discarded
  with an index        1.3 ms         10 blocks read            0 rows discarded
```

Same SQL. Same answer. Same contract. One decision — whether an index exists — moved it by 16×
in time and 3,600× in blocks touched. No API design review would ever catch this, because
nothing about the API changed.

This is the through-line of the whole course: **the contract tells you what is possible; the
storage layer decides what it costs.** You have learned to design the first. Now you learn to
price the second.

---

## What a database actually gives you

It is worth being precise about what you are buying, because "we need a database" is often said
without anyone naming which of these they need:

1. **Durability.** A write that returns success survives a power cut. This is harder than it
   sounds and is why databases fsync, keep a write-ahead log, and are slower than writing to a
   file you never flush.
2. **Concurrency control.** Many clients read and write at once and the result still makes sense.
   This is Lessons 05 and 06, and it is where most of the genuinely surprising bugs live.
3. **Query flexibility.** You can ask questions nobody anticipated when the schema was designed,
   and get an answer in a sensible time. This is what indexes and the query planner buy you.
4. **Integrity.** Rules that hold no matter which application, script or intern is writing.
   Constraints, Lesson 02.

A cache gives you (3) and nothing else. A log file gives you (1) and nothing else. When someone
proposes replacing your database with something faster, the useful question is which of the four
they are proposing to drop — because they are dropping at least one.

---

## The mental model: it is all blocks

Underneath every abstraction in this course is one physical fact. Postgres does not read rows.
It reads **8 KB blocks** (pages), and a block is the smallest unit it will fetch, cache or write.
Everything you are about to learn is a consequence:

- A sequential scan is cheap *per block* and expensive because it reads every block.
- An index is a structure that turns "which rows match?" into "which blocks do I need?" — and it
  is only worth having when the answer is "far fewer than all of them."
- `shared_buffers` is a cache of blocks. A block already in memory is roughly 100× cheaper than
  one that has to come off disk, which is why the plan output in this lab reports `hit` and
  `read` separately.
- A row update does not edit a row in place. It writes a *new version* of the row into a block
  and leaves the old one behind for later cleanup — which is how readers avoid blocking writers
  (Lesson 05) and why VACUUM exists (Lesson 08).

When a number in this course surprises you, count blocks. The answer is almost always there.

---

## What you should now be able to do

- [ ] Explain why a stateless service scales by adding copies and a database does not.
- [ ] Name the four things a database gives you, and say which one a proposed replacement drops.
- [ ] Explain why two endpoints with identical contracts can differ 1000× in cost.
- [ ] Describe, in terms of 8 KB blocks, why an index helps some queries and not others.

**Artifact for this module:** a one-page **storage cost map** of a system you actually work on.
List its top five read paths and its top three write paths. For each one, write down: which store
answers it, roughly how many rows it touches, whether it is indexed for that access pattern, and
what happens to that number as the table grows 100×. You will not know every answer — mark the
gaps as gaps. *An honest map with three question marks is worth more than a confident one with
none, and the question marks are your reading list for the rest of this course.*

Next: [02 · Schema design and the constraints that outlive your code](02-schema-design-and-constraints.md)
