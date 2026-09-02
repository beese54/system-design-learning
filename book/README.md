# The book

A reader for the System Design course. One book, one chapter per course folder,
one lesson per markdown file.

```
open index.html          read it
node build.mjs           re-typeset after editing any lesson
```

There is no install step and no dependencies. Double-clicking `index.html` works —
everything is relative paths and classic scripts, and the reader degrades gracefully
if `localStorage` is unavailable. (If your browser is strict about `file://`, run
`python -m http.server 4200` here and open `http://localhost:4200`.)

---

## How it fits together

```
system_design_learning/
├── API Design/lessons/*.md        ← source of truth
├── Data & Storage/lessons/*.md    ← source of truth
└── book/
    ├── book.config.json    which chapters, in what order, with what blurb
    ├── build.mjs           markdown → HTML
    ├── content.js          GENERATED — never edit by hand
    ├── index.html          the shell
    ├── reader.css          the design
    └── reader.js           routing, contents, keyboard, resume
```

**The markdown is the master copy.** The book never edits your lessons and never holds
the only copy of anything. `content.js` is disposable — delete it and re-run the build.

---

## Adding a chapter

1. Write `<Your Chapter>/lessons/01-….md`, `02-….md`, and so on.
2. Add an entry to `book.config.json`:

```json
{
  "dir": "Caching",
  "title": "Caching",
  "numeral": "III",
  "blurb": "One sentence for the chapter title page.",
  "lab": "http://localhost:4200"
}
```

3. `node build.mjs`

`dir` is the folder name exactly as it appears on disk. Lessons are picked up in
filename order, so keep the numeric prefixes.

---

## Lesson formatting the build understands

Headings, bold, italic, inline code, fenced code, tables, blockquotes, ordered and
unordered lists, task lists, horizontal rules, links.

A few conventions matter:

| Write this | You get |
|---|---|
| `# Lesson 3 — Title` or `# 03 · Title` | the lesson number and title (both chapters' styles work) |
| `**Lab:** … **Time:** …` as the first paragraph | a callout box, not body text |
| `- [ ] item` | a checklist — used for the closing objectives |
| `[text](04-indexes.md)` | an in-book link to that lesson |
| `[text](../API%20Design/README.md)` | a link to that chapter's contents |
| `http://localhost:4000` | a marked lab link (opens in a new tab) |
| a link to any other file | plain text with a tooltip, since that file is not in the book |

The build reads every lesson twice: once to learn all the titles and numbers, and once
to convert, so a link from Chapter I to a Chapter II lesson resolves even though
Chapter II had not been read yet on the first pass.

---

## Reading

| | |
|---|---|
| `←` `→` | previous / next lesson, across chapter boundaries |
| `t` | show or hide the contents |
| `Esc` | back to the title page |

The URL carries the location — `#/data-storage/3` is lesson 3 of Chapter II — so lessons
can be bookmarked and linked. Where you stopped is remembered, and the cover offers to
resume. Theme follows your system and the sun icon overrides it.

---

## Notes

- **Lessons only.** Exercises, worksheets and the labs stay as files in the chapter
  folders; the book is the reading material.
- **No markdown library.** `build.mjs` includes a small converter for the subset the
  lessons actually use. Same argument the labs make about frameworks: 250 lines you can
  read beats a dependency you cannot.
- **Fonts** come from Google Fonts. Offline they fall back to Georgia and Consolas, which
  is a downgrade but not a break.
