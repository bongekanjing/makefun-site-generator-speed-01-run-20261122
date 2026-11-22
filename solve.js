// A faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input: every path the build writes, mapped to that file's text,
// byte for byte. The semantics below mirror the reference program's README and
// code (front matter, template dialect, Markdown subset, slug rule, report);
// the code itself is written from scratch, organised for speed:
//
//   - HTML escaping scans with one shared regex and never copies clean text.
//   - Inline Markdown renders in a single pass into a chunk array, finding
//     closers with indexOf instead of a character walk.
//   - Block lexing classifies lines with direct character tests, no regexes.
//   - Slugs are memoised per build and take an ASCII fast path.
//   - Templates are parsed once into compact array nodes and rendered into a
//     shared chunk array; a for-loop reuses one scope object per element.
//   - Word counting and front-matter parsing avoid throwaway arrays.
//
// Nothing is cached between cases: every run() call builds fresh per-case
// state (slug and date memos included).

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Order by UTF-16 code unit, never by locale. */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Shared escape scanner; every use sets lastIndex first, so reuse is safe. */
const ESC_RE = /[&<>"']/g;

// ---------------------------------------------------------------- utilities

/** True when the code unit is one of JavaScript's \s characters. */
function isWS(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) ||
    c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/**
 * Push s[a..b) HTML-escaped onto `out`. Clean text is pushed as one slice;
 * only the characters the escape table names are replaced.
 */
function escRange(s, a, b, out) {
  if (a >= b) return;
  ESC_RE.lastIndex = a;
  let m;
  let last = a;
  while ((m = ESC_RE.exec(s)) !== null && m.index < b) {
    out.push(s.slice(last, m.index), ESCAPES[m[0]]);
    last = m.index + 1;
  }
  out.push(s.slice(last, b));
}

/** The whole of `s`, escaped, pushed onto `out`. */
function escWhole(s, out) {
  escRange(s, 0, s.length, out);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters with a "-" left at the cut dropped, "untitled" when nothing is
 * left. Pure-ASCII input skips the normalisation step (NFKD is the identity
 * there and no mark can occur). Results are memoised in `memo`.
 */
function slugOf(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) {
      ascii = false;
      break;
    }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = e === out.length ? out : out.slice(0, e);
  if (out === '') out = 'untitled';
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. Memoised in `memo`. */
function longDate(date, memo) {
  let hit = memo.get(date);
  if (hit === undefined) {
    hit = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    memo.set(date, hit);
  }
  return hit;
}

/** How many words `text` holds: its runs of non-whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? c === 32 || (c >= 9 && c <= 13) : isWS(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted-or-bare string value, or why it is refused. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `c` is a lowercase ASCII letter or digit. */
const isLowerAlnum = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);

/** One key's value, or why it is refused. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) {
            return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!isLowerAlnum(c) && c !== 45) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let i = 0;
      while (ok && i < raw.length) {
        const start = i;
        while (i < raw.length && isLowerAlnum(raw.charCodeAt(i))) i++;
        if (i === start) ok = false;
        else if (i === raw.length) break;
        else if (raw.charCodeAt(i) !== 45) ok = false;
        else {
          i++;
          if (i === raw.length) ok = false;
        }
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The body is sliced
 * straight out of the text; only the front-matter lines are walked.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Collect the lines between the opening --- and the closing one.
  const fm = [];
  let pos = text.length > 3 ? 4 : 3;
  let closed = false;
  let bodyAt = text.length;
  while (pos < text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (text.slice(pos, end) === '---') {
      closed = true;
      bodyAt = e === -1 ? text.length : e + 1;
      break;
    }
    fm.push(text.slice(pos, end));
    if (e === -1) break;
    pos = e + 1;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fm.length; k++) {
    const line = fm[k];
    // Blank (spaces and tabs only) or a comment: skipped.
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of a-z and _, a colon, one space and the value.
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || line.charCodeAt(j) !== 58) {
      return { error: `line ${k + 2} is not "key: value"` };
    }
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${k + 2} is not "key: value"` };
    let t = raw.length;
    while (t > 0) {
      const c = raw.charCodeAt(t - 1);
      if (c !== 32 && c !== 9) break;
      t--;
    }
    raw = t === raw.length ? raw : raw.slice(0, t);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- Markdown

const SP = 32;
const TAB = 9;

/** True when the line holds only spaces and tabs (or nothing). */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

/** A fence's language, or null when the line does not open one. */
function fenceLang(s) {
  if (s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45
    ) i++;
    else break;
  }
  const lang = s.slice(3, i);
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== SP && c !== TAB) return null;
    i++;
  }
  return lang;
}

/** True when the line closes a fence: three backticks, spaces or tabs after. */
function isFenceClose(s) {
  if (s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(s) {
  let n = 0;
  while (n < 6 && s.charCodeAt(n) === 35) n++;
  if (n === 0 || s.charCodeAt(n) === 35) return null;
  const c = s.charCodeAt(n);
  if (c !== SP && c !== TAB) return null;
  let j = n;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if (d !== SP && d !== TAB) break;
    j++;
  }
  let e = s.length;
  while (e > j) {
    const d = s.charCodeAt(e - 1);
    if (d !== SP && d !== TAB) break;
    e--;
  }
  if (e === j) return null;
  return { depth: n, text: s.slice(j, e) };
}

/** True for a thematic break: --- or ***, then spaces or tabs only. */
function isHr(s) {
  const c0 = s.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(1) !== c0 || s.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

/** A bullet item's rest, or null. */
function bulletOf(s) {
  const c = s.charCodeAt(0);
  if (c !== 45 && c !== 42) return null;
  if (s.charCodeAt(1) !== SP) return null;
  return s.slice(2);
}

/** An ordered item's number and rest, or null. */
function orderedOf(s) {
  let i = 0;
  let n = 0;
  while (i < 9) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      n = n * 10 + (c - 48);
      i++;
    } else break;
  }
  if (i === 0) return null;
  if (s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== SP) return null;
  return { num: n, rest: s.slice(i + 2) };
}

/** True for a list continuation: two or more spaces, then a non-space. */
function isContinued(s) {
  let i = 0;
  while (s.charCodeAt(i) === SP) i++;
  if (i < 2 || i >= s.length) return false;
  return !isWS(s.charCodeAt(i));
}

/** A line with spaces and tabs dropped at either end. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== SP && c !== TAB) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== SP && c !== TAB) break;
    b--;
  }
  return s.slice(a, b);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** True when `c` (a code unit) is one a backslash escapes. */
function isEscapable(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62
  );
}

/**
 * How many backslashes stand immediately before `at`, counting only from
 * `from`. Odd means the character at `at` is escaped.
 */
function backslashesBefore(s, at, from) {
  let n = 0;
  for (let p = at - 1; p >= from && s.charCodeAt(p) === 92; p--) n++;
  return n;
}

/**
 * The first index in [from, end) where `what` occurs outside a backslash
 * escape, or -1. Found with indexOf; a hit preceded by an odd run of
 * backslashes is escaped, so the search resumes just past it.
 */
function findUnescaped(s, what, from, end) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= end) {
    if (backslashesBefore(s, j, from) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/**
 * The first single * in [from, end): one whose run is not **, outside an
 * escape, or -1.
 */
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (backslashesBefore(s, j, from) % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** True when `s` holds any whitespace character (JavaScript's \s). */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** The characters that can start an inline construct: backslash, backtick, star, [. */
const MARK_RE = /[\\`*\[]/g;

/**
 * `s[a..b)` rendered inline, appended to `out`. `link` resolves a link's
 * target to its href. The scan jumps from one markup character to the next
 * with a regex instead of walking every character; the plain stretch between
 * two constructs is escaped in one pass each. The closers of code spans,
 * strong, emphasis and links are found with indexOf.
 */
function inlineInto(s, link, out, a, b) {
  let i = a;
  while (i < b) {
    MARK_RE.lastIndex = i;
    const m = MARK_RE.exec(s);
    const j = m !== null && m.index < b ? m.index : b;
    if (j > i) escRange(s, i, j, out);
    if (j >= b) return;
    const c = s.charCodeAt(j);
    if (c === 92) {
      const n = s.charCodeAt(j + 1);
      if (j + 1 < b && isEscapable(n)) {
        // The escaped character is still written escaped: '>' is both
        // escapable and in the escape table, so \> is &gt;.
        escRange(s, j + 1, j + 2, out);
        i = j + 2;
        continue;
      }
      escRange(s, j, j + 1, out);
      i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>');
        escRange(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
        continue;
      }
      escRange(s, j, j + 1, out);
      i = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s, link, out, j + 2, k);
          out.push('</strong>');
          i = k + 2;
          continue;
        }
        escRange(s, j, j + 2, out);
        i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        out.push('<em>');
        inlineInto(s, link, out, j + 1, k);
        out.push('</em>');
        i = k + 1;
        continue;
      }
      escRange(s, j, j + 1, out);
      i = j + 1;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1, b);
    let m2 = -1;
    if (k !== -1 && s.charCodeAt(k + 1) === 40) {
      const q = s.indexOf(')', k + 2);
      if (q !== -1 && q < b) m2 = q;
    }
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !hasWS(target)) {
      out.push('<a href="');
      escWhole(link(target), out);
      out.push('">');
      inlineInto(s, link, out, j + 1, k);
      out.push('</a>');
      i = m2 + 1;
      continue;
    }
    escRange(s, j, j + 1, out);
    i = j + 1;
  }
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or ""). Blocks are
 * rendered as they are lexed, so no token list is built.
 */
function renderMarkdown(src, link, slugMemo) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = '';
  let haveExcerpt = false;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') {
        out.push(' class="language-');
        escWhole(lang, out);
        out.push('"');
      }
      out.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        escWhole(lines[i], out);
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugOf(h.text, slugMemo), ids);
      out.push(`<h${h.depth} id="${id}">`);
      if (h.depth === 2 || h.depth === 3) {
        const tmp = [];
        inlineInto(h.text, link, tmp, 0, h.text.length);
        const html = tmp.join('');
        out.push(html, `</h${h.depth}>\n`);
        toc.push({ level: h.depth, id, html });
      } else {
        inlineInto(h.text, link, out, 0, h.text.length);
        out.push(`</h${h.depth}>\n`);
      }
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === SP ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        const joined = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(joined, link, out, 0, joined.length);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        let m = null;
        let first = null;
        if (isOrdered) {
          const o = orderedOf(lines[i]);
          if (o !== null) {
            m = o;
            first = trimLine(o.rest);
          }
        } else {
          const bl = bulletOf(lines[i]);
          if (bl !== null) first = trimLine(bl);
        }
        if (first !== null) {
          items.push([first]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const start = isOrdered ? ordered.num : 1;
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : isOrdered ? '<ol>' : '<ul>');
      out.push('\n');
      for (const parts of items) {
        const joined = parts.join('\n');
        out.push('<li>');
        inlineInto(joined, link, out, 0, joined.length);
        out.push('</li>\n');
      }
      out.push(isOrdered ? '</ol>' : '</ul>');
      out.push('\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const joined = body.join('\n');
    if (!haveExcerpt) {
      const tmp = [];
      inlineInto(joined, link, tmp, 0, joined.length);
      excerpt = tmp.join('');
      haveExcerpt = true;
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(joined, link, out, 0, joined.length);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Node kinds in a parsed template: text, var, raw, for, if, include. */
const N_TEXT = 0;
const N_VAR = 1;
const N_RAW = 2;
const N_FOR = 3;
const N_IF = 4;
const N_INCLUDE = 5;

/** Whether `c` can start a name (a letter or _). */
const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
/** Whether `c` can continue a name (a letter, a digit or _). */
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57);

/** True when `t` is a path: names joined by dots. */
function isPath(t) {
  if (t.length === 0) return false;
  let i = 0;
  for (;;) {
    if (!isNameStart(t.charCodeAt(i))) return false;
    i++;
    while (i < t.length && isNameChar(t.charCodeAt(i))) i++;
    if (i === t.length) return true;
    if (t.charCodeAt(i) !== 46) return false;
    i++;
    if (i === t.length) return false;
  }
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!isPath(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** True when s[a..b) holds only spaces and tabs. */
function spacesOnly(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

/**
 * `src`'s tokens: [0, text], [1, path] ({{ }}), [2, path] ({{{ }}}),
 * [3, tag] ({% %}). A {% %} tag alone on its line takes the whole line
 * with it, its newline included. Text, {{ }} and {{{ }}} never do.
 */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push([N_TEXT, text]);
      text = '';
      tokens.push([raw ? N_RAW : N_VAR, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = spacesOnly(src, lineStart, open) && spacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push([N_TEXT, text]);
    text = '';
    tokens.push([3, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push([N_TEXT, text]);
  return tokens;
}

/** A for tag's name and path text, or null when the tag is not a for. */
function forTag(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (!isNameStart(tag.charCodeAt(i))) return null;
  const start = i;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const varName = tag.slice(start, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const pathText = tag.slice(i + 4);
  if (pathText === '' || hasWS(pathText)) return null;
  return { varName, pathText };
}

/** An if tag's negation and path text, or null when the tag is not an if. */
function ifTag(tag) {
  if (!tag.startsWith('if ')) return null;
  let i = 3;
  let not = false;
  if (tag.slice(i, i + 4) === 'not ') {
    not = true;
    i += 4;
  }
  const pathText = tag.slice(i);
  if (pathText === '' || hasWS(pathText)) return null;
  return { not, pathText };
}

/** An include tag's template name, or null when the tag is not one. */
function includeTag(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"')) return null;
  const inner = tag.slice(9, -1);
  if (inner === '') return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

/**
 * `src` parsed into its tree of nodes. A node is an array whose first item
 * is its kind: text [0, text], var [1, path], raw [2, path],
 * for [3, name, path, body], if [4, not, path, then, else],
 * include [5, name].
 */
function parseTemplate(name, src) {
  const root = [];
  // Open blocks: { kind, node, body } where body is the array nodes append to.
  const stack = [{ kind: 'root', node: null, body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok[0] === N_TEXT) {
      body.push([N_TEXT, tok[1]]);
      continue;
    }
    if (tok[0] === N_VAR || tok[0] === N_RAW) {
      body.push([tok[0], tok[1]]);
      continue;
    }
    const tag = tok[1];
    const top = stack[stack.length - 1];
    let m;
    if ((m = forTag(tag)) !== null) {
      const node = [N_FOR, m.varName, pathOf(name, m.pathText), []];
      body.push(node);
      stack.push({ kind: 'for', node, body: node[3] });
      body = node[3];
    } else if ((m = ifTag(tag)) !== null) {
      const node = [N_IF, m.not, pathOf(name, m.pathText), [], null];
      body.push(node);
      stack.push({ kind: 'if', node, body: node[3] });
      body = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.node[4] !== null) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      top.node[4] = [];
      top.body = top.node[4];
      body = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.body;
    } else if ((m = includeTag(tag)) !== null) {
      body.push([N_INCLUDE, m]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root;
}

/** The value at `path` in the scope chain, or undefined. */
function lookup(scope, path) {
  const first = path[0];
  let s = scope;
  while (s !== null) {
    const vars = s.vars;
    if (Object.hasOwn(vars, first)) {
      let v = vars[first];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
    s = s.parent;
  }
  return undefined;
}

/** A value as text: a string itself, a number in its own digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) into `out`. `ctx` holds the
 * parsed templates and the include depth. A for-loop reuses one scope object
 * across its elements: rendering is synchronous, so no iteration can see
 * another's bindings.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    switch (nd[0]) {
      case N_TEXT:
        out.push(nd[1]);
        break;
      case N_VAR:
        escWhole(textOf(lookup(scope, nd[1])), out);
        break;
      case N_RAW:
        out.push(textOf(lookup(scope, nd[1])));
        break;
      case N_IF: {
        const v = truthy(lookup(scope, nd[2]));
        const branch = v !== nd[1] ? nd[3] : nd[4];
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case N_FOR: {
        const xs = lookup(scope, nd[2]);
        if (!Array.isArray(xs)) break;
        const vars = Object.create(null);
        const loop = { index: 0, first: true, last: false, length: xs.length };
        vars.loop = loop;
        const child = { vars, parent: scope };
        for (let j = 0; j < xs.length; j++) {
          vars[nd[1]] = xs[j];
          loop.index = j + 1;
          loop.first = j === 0;
          loop.last = j === xs.length - 1;
          renderNodes(nd[3], child, ctx, depth, out);
        }
        break;
      }
      case N_INCLUDE: {
        const t = ctx.templates.get(nd[1]);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** True when `target` carries a scheme (https:, mailto:, ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46
    ) i++;
    else break;
  }
  return target.charCodeAt(i) === 58;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugMemo = new Map();
  const dateMemo = new Map();

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; the first failing check is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title, slugMemo), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name, slugMemo);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugOf(name, slugMemo);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // Cards, pages and links as templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateMemo),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateMemo),
        };
  const pageOf = (s) => ({
    // A post's card is already built in the cards map; a page builds its own.
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map((p) => cards.get(p)),
  });

  // 7. Layouts: every page through its layout, the index and tag pages.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
