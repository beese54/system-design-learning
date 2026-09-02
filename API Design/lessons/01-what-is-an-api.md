# Lesson 1 — What an API actually is

**Lab:** open <http://localhost:4000> → tab **1 · Anatomy**, press *Send a real request*.
**Time:** 20 minutes reading, 25 minutes in the lab.

---

## The one-sentence definition

> An API is a **promise about behaviour across a boundary**.

One side promises to accept certain messages and answer in a certain shape. The other side
promises to ask only in that vocabulary. Everything on the far side of the promise — the
language, the database, the deploy schedule, the person on call — is private and swappable.

Most confusion about APIs comes from mistaking the *implementation* for the *interface*.
When you call `GET /rest/v1/artists/a1` in the lab, you learn nothing about how the server
stores artists. That ignorance is not a limitation. It **is the product**.

```
   ┌──────────────┐        the promise         ┌──────────────────┐
   │   Client     │ ─────────────────────────▶ │  Implementation  │
   │              │  URL · method · payload    │                  │
   │ knows only   │  status codes · errors     │  free to change  │
   │ the contract │ ◀───────────────────────── │  behind the line │
   └──────────────┘        the response        └──────────────────┘
                            ▲
                 this line is the API.
                 everything else is detail.
```

## Why "promise" and not "endpoint"

Because the promise is what people build on, and it is bigger than the URL list:

| Part of the promise | Example | Break it and… |
|---|---|---|
| **Address** | `/v1/artists/{id}` | every client 404s |
| **Method semantics** | `GET` is safe and repeatable | proxies cache a write, or retries duplicate a charge |
| **Payload shape** | `{ "id": "a1", "name": "…" }` | clients crash on a missing field |
| **Status vocabulary** | `404` means gone, `422` means your input is wrong | clients cannot tell "retry" from "give up" |
| **Error format** | one shape for every failure | every integration writes bespoke parsing |
| **Timing behaviour** | this call answers in <200 ms | a client's page-load budget silently blows |
| **Change policy** | additive only, 6-month deprecations | trust, and then the integration, ends |

Anything a consumer can observe and come to depend on is part of your API, whether you meant it
to be or not. That includes the order of a list you never promised to sort — someone *is*
depending on it right now.

## Three kinds of API, three different jobs

The word covers several things. Keep them apart, because their rules differ:

1. **Library / language APIs** — function signatures in code you import. Coupled at compile time.
2. **Web / network APIs** — messages crossing a process or network boundary. This course is
   about these.
3. **Platform APIs** — what an OS, browser or cloud exposes. Same idea, larger blast radius.

They share the design principles in Lesson 3. They differ in *cost of change*: rename a
private function and your compiler tells you; rename a JSON field and you find out from
someone's angry post six weeks later.

## What you actually did in the lab

Pressing *Send a real request* runs this exchange:

```http
GET /rest/v1/artists/a1 HTTP/1.1
Host: localhost:4000
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
ETag: "0f9c1e6b8a3d2f41"
Cache-Control: public, max-age=60

{ "id": "a1", "type": "artist", "name": "Nova Kim", … }
```

Five design decisions are visible in ten lines, and every one of them was a choice:

- **`GET`** — safe and idempotent. Any proxy, browser or retry layer may repeat it freely.
- **`/artists/a1`** — a noun with an address, so it can be linked to, cached and bookmarked.
- **`200`** — success is in the status line, not buried in the body.
- **`ETag`** — the response is identified, so the next request can ask "still this one?" and
  get an empty `304` back. Try it: tick *send If-None-Match* on the REST tab.
- **`Cache-Control`** — the server states how long the answer stays true. That single header
  can remove more load than a week of query optimisation.

## The mental model to keep

An API is a **product with users** — even an internal one whose users sit ten feet away.
That reframing predicts most of the good advice in this course:

- Products get **documentation** and examples that run.
- Products get **versions** and deprecation notices, not silent changes.
- Products are designed around **what users are trying to do**, not around your storage.
- Products have **support costs**: every ambiguity in the contract becomes a message to you.

## What you should now be able to do

- [ ] Define an API without using the word "endpoint".
- [ ] List what is inside a contract beyond the URL and the JSON fields.
- [ ] Explain why hiding the implementation is the feature, not a side effect.
- [ ] Point at a response in the lab and name the design decision behind each header.

**Artifact for this module:** pick an API you use every day (Stripe, GitHub, your own team's).
Write one page: what it promises, what it hides, and what would break tomorrow if its owners
renamed one field. Keep it — Lesson 3 will ask you to grade it.

Next: [Lesson 2 — APIs in system architecture](02-apis-in-system-architecture.md)
