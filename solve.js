// Fast drop-in replacement for makefun-site 1.0.0 (site-generator-speed-01).
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns for the same input — every path,
// every file's text, byte for byte — but computed with a leaner engine: the front-matter, Markdown and template
// dialects are reimplemented here as hand-written scanners (no regex in the hot paths), slug and date formatting
// are memoised across the build, cards are built once per source, and text is rendered in single passes that
// avoid intermediate token arrays. The semantics follow the reference program's README and code wherever the
// two could differ: its front-matter refusals and their order, its slug rule (NFKD, marks dropped, 64-char cut),
// its Markdown subset (fences, ATX headings, breaks, quotes, flat lists, paragraphs; code spans, strong, em,
// links and backslash escapes inline), its template dialect ({{ }}, {{{ }}}, for/if/include, standalone tag
// lines) and its build report.

const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** `s` with & < > " ' escaped; returns `s` itself when there is nothing to escape. */
function escapeHtml(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  if (i === n) return s;
  let out = s.slice(0, i);
  let last = i;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += s.slice(last, i) + rep;
    last = i + 1;
  }
  return out + s.slice(last);
}

const slugCache = new Map();

/** The slug of `text`, memoised: titles, tag names and headings repeat across a site. */
function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    slugCache.set(text, v);
  }
  return v;
}

/** NFKD, combining marks dropped, A-Z lowered, runs of anything else one "-", cut at 64, "untitled" when empty. */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  // Only a-z, 0-9 and A-Z are ever kept, all ASCII, so scanning code units matches the reference's code points.
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
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, 63); // a "-" left at the cut is dropped (no "--" can occur)
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone, memoised. */
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, v);
  }
  return v;
}

/** Whether `c` (a char code) is JavaScript whitespace, as \s sees it. */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace (the reference's /\S+/g count). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (c < 0xa0 || !isWsCode(c)) {
      if (!inWord) {
        inWord = true;
        count++;
      }
    } else inWord = false;
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let esc = -1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92 || c === 34) {
        esc = i;
        break;
      }
    }
    if (esc === -1) return { value: raw.slice(1, -1) };
    let out = raw.slice(1, esc);
    for (let i = esc; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          const c = raw.charCodeAt(i);
          if (i === 4 || i === 7) {
            if (c !== 45) { ok = false; break; }
          } else if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether a line is blank: spaces and tabs only. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line's trailing spaces and tabs dropped. */
function trimTrail(line) {
  let b = line.length;
  while (b > 0) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return b === line.length ? line : line.slice(0, b);
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. Lines are scanned by offset rather than split, and the closing "---" is located before any line
 * is judged, exactly as the reference orders it.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // The spans [start, end) of every line after the first, up to and including the closing "---".
  const spans = [];
  let close = -1;
  let p = nl0 === -1 ? text.length : nl0 + 1;
  for (let idx = 1; ; idx++) {
    const e = text.indexOf('\n', p);
    const end = e === -1 ? text.length : e;
    spans.push([p, end]);
    if (end - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      close = idx;
      break;
    }
    if (e === -1) break;
    p = e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < close - 1; j++) {
    const line = text.slice(spans[j][0], spans[j][1]);
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    let raw = null;
    if (k > 0 && line.charCodeAt(k) === 58) {
      if (k === line.length - 1) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = trimTrail(line.slice(k + 2));
    }
    if (raw === null) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const closeEnd = spans[close - 1][1];
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

/** A fence's opening line: its language, or null. Three backticks, language chars, then spaces/tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** A fence's closing line: three backticks, then spaces/tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

let hDepth = 0;
let hText = '';

/**
 * A heading line scanned: true when it is one, with hDepth and hText set (a heading's text is never empty).
 * Scratch results instead of an object, because the paragraph scan asks this of every line.
 */
function scanHeading(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= line.length) return false;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return false;
  let j = i;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return false;
  hDepth = i;
  hText = line.slice(j, e);
  return true;
}

/** A thematic break: "---" or "***", then spaces/tabs only. */
function isHR(line) {
  let rest;
  if (line.startsWith('---')) rest = 3;
  else if (line.startsWith('***')) rest = 3;
  else return false;
  for (let j = rest; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text ("- " or "* " dropped), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item's number and text ("<digits>. " dropped), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation: two or more spaces (spaces only) then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWsCode(line.charCodeAt(i));
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || scanHeading(line) || isHR(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index in [from, b) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, b) {
  const wl = what.length;
  for (let j = from; j <= b - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < b && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, b) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, b) {
  for (let j = from; j < b; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < b && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < b && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_CHAR = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. Mirrors the reference's left-to-right scan. */
function inline(s, env) {
  return inlineRange(s, 0, s.length, env);
}

/**
 * The range s[a, b) rendered inline, in place: nested strong, emphasis and link text recurse on ranges of the
 * same string instead of sliced copies. Every search is bounded by b, exactly as it would be on the slice.
 */
function inlineRange(s, a, b, env) {
  let out = '';
  let i = a;
  while (i < b) {
    const c = s[i];
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      out += escapeHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < b) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          out += `<strong>${inlineRange(s, i + 2, j, env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        out += `<em>${inlineRange(s, i + 1, j, env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      const m = k !== -1 && k + 1 < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= b ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_CHAR.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inlineRange(s, i + 1, k, env)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    // A plain run: everything up to the next character that can open an inline construct, noting the first
    // HTML-special along the way — a run with none is appended as it stands, with no second scan to escape it.
    let j = i;
    let sp = -1;
    while (j < b) {
      const d = s[j];
      if (d === '\\' || d === '`' || d === '*' || d === '[') break;
      if (sp === -1 && (d === '&' || d === '<' || d === '>' || d === '"' || d === "'")) sp = j;
      j++;
    }
    if (j === i) {
      // s[i] is a backslash no escape follows: it is itself.
      out += '\\';
      i++;
      continue;
    }
    out += sp === -1 ? s.slice(i, j) : escapeHtml(s.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block followed by "\n"), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      let body = '';
      i++;
      while (i < n && !fenceClose(lines[i])) {
        body += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      html += lang === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>\n`;
      continue;
    }
    if (scanHeading(line)) {
      const id = uniqueSlug(slugify(hText), ids);
      const inner = inline(hText, env);
      html += `<h${hDepth} id="${id}">${inner}</h${hDepth}>\n`;
      if (hDepth === 2 || hDepth === 3) toc.push({ level: hDepth, id, html: inner });
      i++;
      continue;
    }
    if (isHR(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') kept.push(t);
        i++;
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const b0 = bulletOf(line);
    const o0 = b0 === null ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrd = o0 !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        let itemText = null;
        if (isOrd) {
          const m = orderedOf(l);
          if (m !== null) itemText = m.text;
        } else if (bulletOf(l) !== null) itemText = bulletOf(l);
        if (itemText !== null) {
          items.push([trimLine(itemText)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      let lis = '';
      for (const parts of items) lis += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += isOrd ? `${o0.num !== 1 ? `<ol start="${o0.num}">` : '<ol>'}\n${lis}</ol>\n` : `<ul>\n${lis}</ul>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const inner = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', node: null, body: root }];
  for (const tok of tokenize(name, src)) {
    const frame = stack[stack.length - 1];
    if (tok.t === 'text') frame.body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') frame.body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        frame.body.push(node);
        stack.push({ kind: 'for', node, body: node.body });
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        frame.body.push(node);
        stack.push({ kind: 'if', node, body: node.then });
      } else if (tag === 'else') {
        if (frame.kind !== 'if' || frame.node.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        frame.node.else = [];
        frame.body = frame.node.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (frame.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) frame.body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** lookup for a one-name path (the shape most template paths take). */
function lookup1(scope, a) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  return s === null ? undefined : s.vars[a];
}

/** lookup for a two-name path. */
function lookup2(scope, a, b) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  const v = s.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  return v[b];
}

/** A path's getter, specialised by its length. */
function getterOf(path) {
  if (path.length === 1) {
    const a = path[0];
    return (scope) => lookup1(scope, a);
  }
  if (path.length === 2) {
    const a = path[0];
    const b = path[1];
    return (scope) => lookup2(scope, a, b);
  }
  return (scope) => lookup(scope, path);
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template compiled to a chain of closures, one per node, so rendering is direct concatenation with
 * no per-node dispatch. `ctx` holds the compiled templates (`compiled`, a Map of name to closure) and the HTML
 * escape. A compiled template renders in `scope` ({ vars, parent }) at include depth `depth`.
 */
function compileNodes(nodes) {
  const fns = nodes.map(compileNode);
  return (scope, ctx, depth) => {
    let out = '';
    for (let i = 0; i < fns.length; i++) out += fns[i](scope, ctx, depth);
    return out;
  };
}

function compileNode(nd) {
  switch (nd.kind) {
    case 'text': {
      const t = nd.text;
      return () => t;
    }
    case 'var': {
      const get = getterOf(nd.path);
      return (scope, ctx) => ctx.escape(textOf(get(scope)));
    }
    case 'raw': {
      const get = getterOf(nd.path);
      return (scope) => textOf(get(scope));
    }
    case 'if': {
      const get = getterOf(nd.path);
      const neg = nd.not;
      const thenFn = compileNodes(nd.then);
      const elseFn = nd.else !== null ? compileNodes(nd.else) : null;
      return (scope, ctx, depth) => {
        if (truthy(get(scope)) !== neg) return thenFn(scope, ctx, depth);
        return elseFn !== null ? elseFn(scope, ctx, depth) : '';
      };
    }
    case 'for': {
      const get = getterOf(nd.path);
      const name = nd.name;
      const bodyFn = compileNodes(nd.body);
      // One scope, vars and loop object per for node, mutated per element: a template's include graph has no
      // cycles (an included template never includes its includer back), so a for node is never re-entered while
      // it is rendering, and sequential activations see exactly the keys a fresh scope would hold.
      const loopObj = { index: 0, first: false, last: false, length: 0 };
      const vars = {};
      const scopeObj = { vars, parent: null };
      return (scope, ctx, depth) => {
        const xs = get(scope);
        if (!Array.isArray(xs)) return '';
        let out = '';
        const len = xs.length;
        scopeObj.parent = scope;
        loopObj.length = len;
        for (let k = 0; k < len; k++) {
          vars[name] = xs[k];
          vars.loop = loopObj;
          loopObj.index = k + 1;
          loopObj.first = k === 0;
          loopObj.last = k === len - 1;
          out += bodyFn(scopeObj, ctx, depth);
        }
        return out;
      };
    }
    case 'include': {
      const nm = nd.name;
      return (scope, ctx, depth) => {
        const t = ctx.compiled.get(nm);
        return t !== undefined && depth < INCLUDE_DEPTH ? t(scope, ctx, depth + 1) : '';
      };
    }
  }
  return () => '';
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** makefun-site 1.0.0's answer for one case's input: its output tree, path -> text. */
export function run(input) {
  // Each case is answered alone: the memo tables start empty, so nothing is carried from one case to the next.
  slugCache.clear();
  dateCache.clear();
  // Templates first, in code-unit order of name: one that does not parse is reported and left out. A template
  // that parses is compiled to closures once, here, and rendered from them all build long.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, compileNodes(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit order of path; a ".md" file is a source (line ends made "\n"), any other file is static.
  const files = input.files.slice().sort((x, y) => byCU(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in the reference's order; the first that fails is the one reported.
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
    if (s.path.startsWith('tags/')) {
      report.push(`refused ${s.path}: tags/ is the generator's own`);
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: page/ is the generator's own`);
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

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name. Resolutions are memoised per
  // (directory, target): the generator hands every source in a directory much the same list of targets.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const key = `${dir}\n${target}`;
        let href = linkCache.get(key);
        if (href === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          href = null;
          if (path !== null) {
            const pg = bySource.get(path);
            if (pg !== undefined) href = `${pg.url}${frag}`;
            else if (staticPaths.has(path)) href = `${base}/${path}${frag}`;
          }
          linkCache.set(key, href);
        }
        if (href === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, and equal dates by slug in code-unit order; each post's newer and older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // The tags: grouped by slug, named as first met walking the posts in collection order, by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const arr = s.data.tags ?? [];
    for (let i = 0; i < arr.length; i++) {
      const sl = slugify(arr[i]);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(arr[i]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugify(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // Cards, built once per source and shared by every list that shows them.
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, then the index pages, the tag pages, the tags page, the statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(cardOf);
  const ctx = { compiled: templates, escape: escapeHtml };
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(cardOf),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(cardOf) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCU);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
