// mend: one patch tool for every AI edit format, as SPEC.md specifies.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its
 *  /-separated segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The line break a file uses: CRLF when its first line feed follows a carriage return. */
function fileBreak(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

/** A file's lines: its text split at its own break, the last empty piece after a final break
 *  not a line. An empty file has no lines. */
function fileLines(text: string): string[] {
  if (text === '') return [];
  const br = fileBreak(text);
  const parts = text.split(br);
  if (text.endsWith(br)) parts.pop();
  return parts;
}

function fileEndsWithBreak(text: string): boolean {
  return text !== '' && text.endsWith(fileBreak(text));
}

/** Lines back to text: the break between them, and a final one exactly when asked. */
function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read
 *  from disk. `moves` records the moves edits made, for the R lines of the output. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** Does the path exist as the edits have left it (a directory on disk counts as existing)? */
function virtExists(tree: Tree, p: string): boolean {
  if (tree.now.has(p)) return tree.now.get(p) !== null;
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Section 5: matching lines                                           */
/* ------------------------------------------------------------------ */

/** A line as a tier reads it: tier 0 as it is, tier 1 without trailing spaces and tabs,
 *  tier 2 without leading and trailing spaces and tabs. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O's lines match the file's lines at this tier. */
function occurrencesAt(file: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const normOld = oldLines.map((l) => normLine(l, tier));
  outer: for (let i = 0; i + oldLines.length <= file.length; i++) {
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(file[i + j]!, tier) !== normOld[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** O found at the first tier (0, then 1, then 2; only 0 when strict) where it occurs at
 *  least once, with every occurrence at that tier; null when it occurs at no tier. */
function findMatch(file: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(file, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines N writes in place of O at position `at`: a context line is the file's own
 *  matched line; at tier 2 every other non-blank line that starts with P, the leading
 *  spaces and tabs of O's first line, has that P replaced by F, the file's first matched
 *  line's leading spaces and tabs; at tiers 0 and 1 the lines are written as they are. */
function buildNewLines(
  file: string[],
  at: number,
  oldLines: string[],
  newParts: { text: string; ctx: number }[],
  tier: number,
): string[] {
  const out: string[] = [];
  const P = leadingWs(oldLines[0] ?? '');
  const F = leadingWs(file[at] ?? '');
  for (const part of newParts) {
    if (part.ctx >= 0) {
      out.push(file[at + part.ctx]!);
    } else if (tier === 2) {
      const t = part.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else {
      out.push(part.text);
    }
  }
  return out;
}

/** Apply one O -> N replacement to `lines` at `at`, keeping the file's break and final
 *  break. Used by SEARCH/REPLACE and V4A; unified diffs go through applyHunks below. */
function spliceReplacement(
  lines: string[],
  at: number,
  oldLines: string[],
  newParts: { text: string; ctx: number }[],
  tier: number,
): string[] {
  const repl = buildNewLines(lines, at, oldLines, newParts, tier);
  return [...lines.slice(0, at), ...repl, ...lines.slice(at + oldLines.length)];
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits                                               */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. A wrong command or a missing or
 *  mistyped key is a parse fault, so null means the caller reports one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (virtExists(tree, p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const crlf = fileBreak(before) === '\r\n';
      const plain = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = plain(before);
      const old = plain(oldStr);
      let count = 0;
      let at = -1;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) {
        if (at < 0) at = k;
        count += 1;
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const out = text.slice(0, at) + plain(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const br = fileBreak(before);
      const lines = fileLines(before);
      const finalBreak = fileEndsWithBreak(before);
      if (lineNo < 0 || lineNo > lines.length) throw new Fail('no-match', p);
      lines.splice(lineNo, 0, ...add);
      tree.now.set(p, joinFile(lines, br, finalBreak));
    };
  }
  return null;
}

/** The patch as JSON: one array of edit objects, or JSON Lines, one edit object a line,
 *  blank lines ignored. In array form any fault is parse at the line where the array
 *  starts; in JSON Lines form a line that does not hold one valid edit object is parse
 *  at that line. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const item of v) {
      const e = jsonEditObject(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** The old-file start line from the header (1-based; 0 for an insertion at the top). */
  a: number;
  /** The hunk's body lines, raw: ` `, `-`, `+`, `\` or empty; trailing empty lines removed. */
  body: string[];
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A path as a `--- `/`+++ ` line names it: the text after the four characters, up to the
 *  first tab, with surrounding spaces removed, a leading a/ or b/ removed; /dev/null
 *  means no file. */
function patchPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** A hunk body's old lines O and new lines N (a context line carries the index of the O
 *  line it is), and whether a `\` line follows the hunk's last context or `+` line. */
function hunkParts(body: string[]): { O: string[]; N: { text: string; ctx: number }[]; noEol: boolean } {
  const O: string[] = [];
  const N: { text: string; ctx: number }[] = [];
  for (const raw of body) {
    if (raw === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
    } else if (raw[0] === ' ') {
      const t = raw.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
    } else if (raw[0] === '-') {
      O.push(raw.slice(1));
    } else if (raw[0] === '+') {
      N.push({ text: raw.slice(1), ctx: -1 });
    }
  }
  let lastIdx = -1;
  for (let k = 0; k < body.length; k++) {
    const r = body[k]!;
    if (r === '' || r[0] === ' ' || r[0] === '+') lastIdx = k;
  }
  const noEol = lastIdx >= 0 && lastIdx + 1 < body.length && body[lastIdx + 1]!.startsWith('\\');
  return { O, N, noEol };
}

/** The hunks of a section, in order, each applied to the result of the ones before it.
 *  A hunk takes, of the occurrences at the tier where O is found, the one whose position
 *  is nearest to A - 1 + d (the earlier of two equally near), where d is the sum over the
 *  hunks applied so far of N's length minus O's length; an empty O inserts after the
 *  first A + d lines. A hunk whose matched lines run to the end of the file leaves the
 *  result ending with a line break unless a `\` line follows its last context or `+`
 *  line; otherwise the file's final break stays as it was. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let lines = fileLines(text);
  const br = fileBreak(text);
  let finalBreak = fileEndsWithBreak(text);
  let d = 0;
  for (const hunk of hunks) {
    const { O, N, noEol } = hunkParts(hunk.body);
    if (O.length === 0) {
      const at = Math.min(hunk.a + d, lines.length);
      const wasEnd = at === lines.length;
      lines.splice(at, 0, ...N.map((p) => p.text));
      if (wasEnd) finalBreak = !noEol;
      d += N.length;
      continue;
    }
    const m = findMatch(lines, O, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = m.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of m.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const endsAtEnd = best + O.length === lines.length;
    lines = spliceReplacement(lines, best, O, N, m.tier);
    if (endsAtEnd) finalBreak = !noEol;
    d += N.length - O.length;
  }
  return joinFile(lines, br, finalBreak);
}

/** One section's edit: a creation, a deletion, a move, or a change of the one path. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  return (tree) => {
    if (oldP === null || sec.isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (virtExists(tree, newP)) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const hunk of sec.hunks) {
        for (const raw of hunk.body) {
          if (raw.startsWith('+')) plus.push(raw.slice(1));
        }
      }
      let noEol = false;
      outer: for (let h = sec.hunks.length - 1; h >= 0; h--) {
        const body = sec.hunks[h]!.body;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.startsWith('+')) {
            noEol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
            break outer;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (newP === null || sec.isDelete) {
      const p = oldP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (virtExists(tree, newP)) throw new Fail('exists', newP);
      tree.now.set(oldP, null);
      tree.now.set(newP, applyHunks(cur, sec.hunks, strict, oldP));
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(cur, sec.hunks, strict, oldP));
  };
}

/** The patch as unified diffs: sections start at a `diff --git` line or at a `--- ` line
 *  followed by a `+++ ` line; hunks start at `@@ -A[,B] +C[,D] @@` lines. Lines outside
 *  bodies that are not part of a section header are ignored. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  const n = lines.length;
  const closeHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
    hunk = null;
  };
  const startSection = (): Section => {
    closeHunk();
    const s: Section = {
      pairOld: null,
      pairNew: null,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        closeHunk();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push(line);
        i++;
        continue;
      }
      closeHunk();
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.pairOld = patchPath(line);
        cur.pairNew = patchPath(lines[i + 1]!);
      } else {
        const s = startSection();
        s.pairOld = patchPath(line);
        s.pairNew = patchPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  closeHunk();
  return sections.map((s) => sectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (virtExists(tree, path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const file = fileLines(cur);
    const m = findMatch(file, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.occ.length > 1) throw new Fail('ambiguous', path);
    const out = spliceReplacement(
      file,
      m.occ[0]!,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
      m.tier,
    );
    tree.now.set(path, joinFile(out, fileBreak(cur), fileEndsWithBreak(cur)));
  };
}

/** The patch as SEARCH/REPLACE blocks: a block's path is the nearest line before its
 *  SEARCH line, after the previous block's REPLACE line, that is not blank and does not
 *  start with three backticks; with none the block takes the previous block's path, and
 *  the first block with none is a parse error at its SEARCH line. A SEARCH line with no
 *  `=======` and then `>>>>>>> REPLACE` after it is a parse error at the SEARCH line.
 *  Lines outside blocks are otherwise ignored. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** The anchor text after @@, or null when the chunk has none. */
  anchor: string | null;
  /** True when a `*** End of File` line ended this chunk. */
  eof: boolean;
  /** The chunk's body lines: context, old, or new, with the marker removed. */
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}

/** One V4A section's edit, built from its already-parsed chunks. */
function v4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  moveTo: string | null,
  addLines: string[] | null,
  chunks: V4aChunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (kind === 'add') {
      if (virtExists(tree, path)) throw new Fail('exists', path);
      const lines = addLines ?? [];
      tree.now.set(path, lines.length === 0 ? '' : lines.join('\n') + '\n');
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && virtExists(tree, moveTo)) throw new Fail('exists', moveTo);
    let lines = fileLines(cur);
    const br = fileBreak(cur);
    const finalBreak = fileEndsWithBreak(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let found: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (normLine(lines[k]!, t) === normLine(chunk.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found !== null) break;
        }
        if (found === null) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const O: string[] = [];
      const N: { text: string; ctx: number }[] = [];
      for (const b of chunk.body) {
        if (b.kind === 'ctx') {
          O.push(b.text);
          N.push({ text: b.text, ctx: O.length - 1 });
        } else if (b.kind === 'old') {
          O.push(b.text);
        } else {
          N.push({ text: b.text, ctx: -1 });
        }
      }
      if (O.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines.splice(at, 0, ...N.map((p) => p.text));
        cursor = at + N.length;
        continue;
      }
      let m: { tier: number; occ: number[] } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        let occ = occurrencesAt(lines, O, t).filter((i) => i >= cursor);
        // An end-of-file chunk takes only an occurrence that ends at the file's last
        // line: keep the tier's occurrences that end at the last line, and take the
        // first of those (the first occurrence that ends at the end of the file).
        if (occ.length > 0) {
          m = { tier: t, occ };
          break;
        }
      }
      if (m === null) throw new Fail('no-match', path);
      const at = m.occ[0]!;
      lines = spliceReplacement(lines, at, O, N, m.tier);
      cursor = at + N.length;
    }
    const result = joinFile(lines, br, finalBreak);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

/** The patch as a V4A patch: the first non-blank line is `*** Begin Patch` and the last
 *  non-blank line is `*** End Patch`, else a parse error; between them sections start at
 *  `*** Add File: `, `*** Delete File: ` and `*** Update File: ` lines. Blank lines
 *  between sections are ignored, and blank lines at the end of a section are not part
 *  of it. Any other line is a parse error at its line. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i;
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push(v4aEdit('add', path, null, addLines, [], strict));
      continue;
    }
    if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push(v4aEdit('delete', path, null, null, [], strict));
      continue;
    }
    let j = 0;
    while (j < raw.length && blank(raw[j]!.text)) j++;
    let moveTo: string | null = null;
    if (j < raw.length && raw[j]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[j]!.text.slice('*** Move to: '.length).trim();
      j++;
    }
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    let afterEof = false;
    for (; j < raw.length; j++) {
      const r = raw[j]!;
      if (r.text.startsWith('@@')) {
        cur = { anchor: r.text.slice(2).trim(), eof: false, body: [] };
        chunks.push(cur);
        afterEof = false;
        continue;
      }
      if (r.text === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
        cur.eof = true;
        afterEof = true;
        continue;
      }
      if (afterEof) {
        if (blank(r.text)) continue;
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
        if (cur === null) {
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
        }
        if (r.text === '') cur.body.push({ kind: 'ctx', text: '' });
        else if (r.text[0] === ' ') cur.body.push({ kind: 'ctx', text: r.text.slice(1) });
        else if (r.text[0] === '-') cur.body.push({ kind: 'old', text: r.text.slice(1) });
        else cur.body.push({ kind: 'new', text: r.text.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${r.idx + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
    edits.push(v4aEdit('update', path, moveTo, null, chunks, strict));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 4: detecting the format                                     */
/* ------------------------------------------------------------------ */

/** With --format=auto the format is the first of these that holds: the first non-blank
 *  line is `*** Begin Patch` (v4a); the first non-whitespace character of the first
 *  non-blank line is `[` or `{` (json); some line is `<<<<<<< SEARCH` (search-replace);
 *  some line starts with `diff --git `, or some line starts with `--- ` and the line
 *  after it starts with `+++ ` (unified). Otherwise no format. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output, order and atomicity       */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  const usage = { code: 2, out: ['error: usage'] };
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage;
        const v = a.slice(9);
        if (!FORMATS.includes(v)) return usage;
        format = v;
      } else if (a === '--check') {
        if (check) return usage;
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage;
        strict = true;
      } else {
        return usage;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
