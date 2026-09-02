// Typesets the book.
//
//   node build.mjs
//
// Reads every chapter listed in book.config.json, converts each lessons/*.md
// file to HTML, and writes content.js. The markdown files stay the source of
// truth - nothing here ever edits them, and content.js is never hand-edited.
//
// Adding a chapter: write the lessons, add one entry to book.config.json,
// re-run this. No other step.
//
// There is no markdown library on purpose. The lessons use a small, known
// subset of markdown, and a 250-line converter you can read beats a dependency
// you cannot - which is the same argument the labs make about frameworks.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Inline markdown: code spans, links, bold, italic.
//
// Order matters. Code spans are pulled out first so their contents are never
// treated as markup, and autolinks are normalised before escaping so that the
// angle brackets do not become entities.
// ---------------------------------------------------------------------------
// A NUL sentinel marks where a code span was lifted out. It cannot occur in
// the lesson text and esc() leaves it alone - unlike a plainer marker such as
// a spaced number, which would match "in 5 minutes" and turn it into code.
const MARK = '\u0000';

function inline(text, ctx) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => MARK + (codes.push(c) - 1) + MARK);

  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, url) => `[${url}](${url})`);
  s = esc(s);

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => link(label, href, ctx));
  // Bold has to tolerate an italic nested inside it - "**a *b* c**" is common
  // in these lessons. Allow single asterisks in the middle, just never a pair.
  s = s.replace(/\*\*((?:[^*]|\*(?!\*))+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s.,;:!?)<]|$)/g, '$1<em>$2</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

// Relative links between lesson files have to become in-book navigation, or
// they 404 the moment the book is opened from anywhere but the lessons folder.
function link(label, href, ctx) {
  const url = decodeURIComponent(href);

  // A lab link only resolves while that chapter's lab is running. Mark it so
  // the reader can style it as what it is rather than as a dead blue link.
  if (/^https?:\/\/localhost:\d+/.test(url)) {
    return `<a class="lab-link" href="${href}" target="_blank" rel="noopener">${label}</a>`;
  }
  if (/^(https?|mailto):/.test(url)) {
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  }

  // ../<Chapter>/README.md  ->  that chapter's contents
  const cross = url.match(/^\.\.\/([^/]+)\/README\.md/i);
  if (cross) {
    const ch = ctx.chapters.find(c => c.dir.toLowerCase() === cross[1].toLowerCase());
    return ch ? `<a href="#/${ch.id}">${label}</a>` : label;
  }
  if (/^\.\.\/README\.md/i.test(url)) return `<a href="#/${ctx.chapter.id}">${label}</a>`;

  // 03-how-a-query-actually-runs.md  ->  the lesson with that filename
  const file = url.split('/').pop();
  const hit = ctx.chapter.lessons.find(l => l.file === file);
  if (hit) return `<a href="#/${ctx.chapter.id}/${hit.n}">${label}</a>`;

  // Anything else points at a file that is not in the book (a worksheet, a
  // lab source file). Keep the words, drop the dead link.
  return `<span class="offbook">${label}</span>`;
}

// ---------------------------------------------------------------------------
// Block markdown. A line-based state machine, because tables and lists need
// to look ahead and a regex pass over the whole document cannot.
// ---------------------------------------------------------------------------
function blocks(md, ctx) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;

  const isTableRow = (l) => /^\s*\|/.test(l);
  const isRule = (l) => /^\s*\|?[\s:-]*-{3,}[\s:|-]*$/.test(l) && l.includes('-');

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // fenced code
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre class="code${lang ? ' lang-' + lang.replace(/[^a-z0-9]/gi, '') : ''}"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // headings (# is the lesson title and is stripped before we get here)
    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl} id="${slug(h[2])}">${inline(h[2], ctx)}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${blocks(buf.join('\n'), ctx)}</blockquote>`);
      continue;
    }

    // table
    if (isTableRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        '<div class="tablewrap"><table><thead><tr>' +
        head.map(c => `<th>${inline(c, ctx)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c, ctx)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>'
      );
      continue;
    }

    // lists, including the "- [ ]" checklists every lesson ends with
    const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items = [];
      let checklist = false;

      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m) {
          if (!items.length || !lines[i].trim()) break;

          // An indented fence inside a list item - Lesson 6 puts a SQL block
          // under a bullet. Collect it as code rather than folding it into the
          // prose, which would strip the newlines and eat the fence markers.
          if (/^\s{2,}```/.test(lines[i])) {
            const body = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
            i++;
            const indent = Math.min(...body.filter(x => x.trim()).map(x => x.match(/^\s*/)[0].length));
            items[items.length - 1] +=
              MARK + 'PRE' + esc(body.map(x => x.slice(indent)).join('\n')) + MARK;
            continue;
          }
          // an ordinary wrapped continuation line belongs to the item above it
          if (/^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1] += ' ' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        let body = m[2];
        const task = body.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) { checklist = true; body = `<span class="box"></span>${task[2]}`; }
        items.push(body);
        i++;
      }

      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}${checklist ? ' class="checklist"' : ''}>` +
        items.map(t => {
          // Splice any collected code blocks back in after inline formatting,
          // so their contents are never treated as markdown.
          const parts = t.split(new RegExp(MARK + 'PRE([\\s\\S]*?)' + MARK));
          return '<li>' + parts.map((p, k) =>
            k % 2 ? `<pre class="code"><code>${p}</code></pre>` : inline(p, ctx)
          ).join('') + '</li>';
        }).join('') + `</${tag}>`);
      continue;
    }

    // paragraph
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*(```|#{2,4}\s|>|---|\*\*\*|___)/.test(lines[i]) &&
           !/^\s*([-*+]|\d+\.)\s/.test(lines[i]) &&
           !isTableRow(lines[i])) {
      buf.push(lines[i++]);
    }
    const text = buf.join('\n');

    // Chapter I opens its lessons with a "**Lab:** … **Time:** …" block. That
    // is metadata, not prose, so it becomes a callout rather than a paragraph.
    if (/^\*\*(Lab|Time)/.test(text.trim())) {
      out.push(`<div class="callout">${inline(text, ctx).replace(/\n/g, '<br>')}</div>`);
    } else {
      out.push(`<p>${inline(text, ctx)}</p>`);
    }
  }
  return out.join('\n');
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// ---------------------------------------------------------------------------
// The two chapters title their lessons differently:
//   Chapter I   # Lesson 1 — What an API actually is
//   Chapter II  # 01 · Why storage is the hard part
// Both have to end up as { n, title }.
// ---------------------------------------------------------------------------
function parseTitle(md, fallbackN) {
  const m = md.match(/^#\s+(.*)$/m);
  if (!m) return { n: fallbackN, title: 'Untitled', rest: md };
  const raw = m[1].trim();
  const t = raw.match(/^(?:Lesson\s+)?(\d+)\s*[—–·|:-]\s*(.+)$/);
  const rest = md.replace(m[0], '').replace(/^\s*---\s*$/m, '');
  return t
    ? { n: Number(t[1]), title: t[2].trim(), rest }
    : { n: fallbackN, title: raw, rest };
}

// ---------------------------------------------------------------------------

async function build() {
  const cfg = JSON.parse(await readFile(join(HERE, 'book.config.json'), 'utf8'));
  const chapters = [];

  for (const [ci, c] of cfg.chapters.entries()) {
    const dir = join(ROOT, c.dir, 'lessons');
    let files;
    try {
      files = (await readdir(dir)).filter(f => f.endsWith('.md')).sort();
    } catch {
      console.error(`  ! no lessons/ folder in "${c.dir}" - skipping`);
      continue;
    }

    const chapter = {
      id: slug(c.title), dir: c.dir, title: c.title, numeral: c.numeral || String(ci + 1),
      blurb: c.blurb || '', lab: c.lab || null, lessons: []
    };

    // Two passes: the first learns every lesson's number and filename so the
    // second can resolve cross-lesson links to lessons it has not read yet.
    const raw = [];
    for (const [i, file] of files.entries()) {
      const md = await readFile(join(dir, file), 'utf8');
      const { n, title, rest } = parseTitle(md, i + 1);
      chapter.lessons.push({ n, title, file, slug: slug(title) });
      raw.push({ n, title, rest });
    }

    const ctx = { chapters, chapter, config: cfg };
    chapters.push(chapter);

    chapter.lessons.forEach((l, i) => {
      const html = blocks(raw[i].rest, ctx);
      const words = raw[i].rest.split(/\s+/).filter(Boolean).length;
      l.html = html;
      l.words = words;
      l.minutes = Math.max(1, Math.round(words / 200));
      // The "What you should now be able to do" list is the lesson's own
      // definition of done; the reader shows it as an objectives card.
      const obj = html.match(/<ul class="checklist">[\s\S]*?<\/ul>/);
      l.objectives = obj ? obj[0] : null;
    });

    console.log(`  ${c.numeral || ci + 1}. ${c.title.padEnd(18)} ${chapter.lessons.length} lessons, ` +
                `${chapter.lessons.reduce((s, l) => s + l.words, 0).toLocaleString('en-US')} words`);
  }

  // Fix the two-pass ordering: chapters is populated as we go, so a link from
  // Chapter I to Chapter II resolved to nothing on the first pass. Re-resolve
  // now that every chapter is known.
  for (const ch of chapters) {
    const ctx = { chapters, chapter: ch };
    const dir = join(ROOT, ch.dir, 'lessons');
    for (const l of ch.lessons) {
      const md = await readFile(join(dir, l.file), 'utf8');
      l.html = blocks(parseTitle(md, l.n).rest, ctx);
      const obj = l.html.match(/<ul class="checklist">[\s\S]*?<\/ul>/);
      l.objectives = obj ? obj[0] : null;
    }
  }

  const book = {
    title: cfg.title, subtitle: cfg.subtitle, kicker: cfg.kicker, colophon: cfg.colophon,
    built: new Date().toISOString().slice(0, 10),
    chapters
  };

  const totalWords = chapters.reduce((s, c) => s + c.lessons.reduce((t, l) => t + l.words, 0), 0);
  await writeFile(
    join(HERE, 'content.js'),
    '/* GENERATED BY build.mjs — DO NOT EDIT.\n' +
    `   ${chapters.length} chapters, ${chapters.reduce((s, c) => s + c.lessons.length, 0)} lessons, ` +
    `${totalWords.toLocaleString('en-US')} words.\n` +
    '   Edit the lesson markdown, then re-run: node build.mjs */\n' +
    'window.BOOK = ' + JSON.stringify(book) + ';\n',
    'utf8'
  );

  console.log(`\n  content.js written — ${chapters.length} chapters, ` +
              `${chapters.reduce((s, c) => s + c.lessons.length, 0)} lessons, ` +
              `${totalWords.toLocaleString('en-US')} words.`);
  console.log('  Open book/index.html in a browser.\n');
}

console.log('\n  Typesetting "' + '…' + '"');
build().catch(e => { console.error(e); process.exit(1); });
