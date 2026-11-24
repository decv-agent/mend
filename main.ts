// mend: one patch tool for every AI edit format (SPEC.md is the contract).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit lists, finds the lines each edit names at
// the first of three whitespace tiers, and writes every change or none. Node 22, standard library only.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { from: string; to: string }[] = [];
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

type Edit = (tree: Tree) => void;

// ---------- file line state (SPEC section 3) ----------

interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitState(text: string): FileState {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, ends: false };
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinState(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.ends ? st.br : '');
}

// ---------- three-tier line matching (SPEC section 5) ----------

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** Every occurrence of O in lines at the first tier that has one, at or after `from`; null when no tier has one. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, mustEndAtFileEnd = false): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
      if (mustEndAtFileEnd && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (!lineEq(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line to write: a context line (the file's own matched line) or a new line of the patch. */
type NEntry = { ctx: number } | { add: string };

/** Resolve the new lines of a match: context lines come from the file, new lines are re-indented at tier 2. */
function resolveN(entries: NEntry[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if ('ctx' in e) {
      out.push(fileLines[pos + e.ctx]!);
      continue;
    }
    let line = e.add;
    if (tier === 2 && o.length > 0 && line.trim() !== '') {
      const p = leadWs(o[0]!);
      const f = leadWs(fileLines[pos]!);
      line = line.startsWith(p) ? f + line.slice(p.length) : line;
    }
    out.push(line);
  }
  return out;
}

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

// ---------- JSON edits (SPEC section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const st = splitState(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, joinState(st));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (SPEC section 6) ----------

type UItem = { k: 'c' | 'o' | 'n' | 'b'; text: string; emptyLine: boolean };
interface UHunk {
  a: number;
  items: UItem[];
}
interface USection {
  diffOld?: string;
  diffNew?: string;
  headOld?: string | null;
  headNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const DEVNULL = null;

function headerPath(raw: string): string | null {
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return DEVNULL;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => {
    const s: USection = { newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = fresh();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.headOld !== undefined) fresh();
      cur!.headOld = headerPath(line.slice(4));
      cur!.headNew = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/.exec(line);
      if (m === null || (m[2] !== '' && !m[2]!.startsWith(' '))) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number.parseInt(m[1]!, 10);
      i += 1;
      const items: UItem[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ')) items.push({ k: 'c', text: bl.slice(1), emptyLine: false });
        else if (bl.startsWith('-')) items.push({ k: 'o', text: bl.slice(1), emptyLine: false });
        else if (bl.startsWith('+')) items.push({ k: 'n', text: bl.slice(1), emptyLine: false });
        else if (bl.startsWith('\\')) items.push({ k: 'b', text: '', emptyLine: false });
        else if (bl === '') items.push({ k: 'c', text: '', emptyLine: true });
        else break;
        i += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.k === 'c' && items[items.length - 1]!.emptyLine) items.pop();
      cur.hunks.push({ a, items });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections;
}

function unifiedEdit(sec: USection): Edit {
  return (tree: Tree, strict = false) => {
    const oldRaw = sec.headOld !== undefined ? sec.headOld : (sec.renameFrom ?? sec.diffOld ?? null);
    const newRaw = sec.headNew !== undefined ? sec.headNew : (sec.renameTo ?? sec.diffNew ?? null);
    const isCreate = sec.newFile || (sec.headOld !== undefined && sec.headOld === DEVNULL);
    const isDelete = sec.delFile || (sec.headNew !== undefined && sec.headNew === DEVNULL);
    for (const p of [oldRaw, newRaw]) {
      if (typeof p === 'string' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      const newP = newRaw as string;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const flat = sec.hunks.flatMap((h) => h.items);
      const texts = flat.filter((it) => it.k === 'n').map((it) => it.text);
      let ends = true;
      const lastN = flat.map((it, ix) => (it.k === 'n' ? ix : -1)).reduce((x, y) => Math.max(x, y), -1);
      if (lastN >= 0 && flat[lastN + 1]?.k === 'b') ends = false;
      tree.now.set(newP, texts.length === 0 ? '' : texts.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const oldP = oldRaw as string;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldP = oldRaw as string;
    const newP = newRaw as string;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const isMove = typeof newP === 'string' && newP !== oldP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const st = splitState(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      const o: string[] = [];
      const entries: NEntry[] = [];
      for (const it of hunk.items) {
        if (it.k === 'c') {
          o.push(it.text);
          entries.push({ ctx: o.length - 1 });
        } else if (it.k === 'o') o.push(it.text);
        else if (it.k === 'n') entries.push({ add: it.text });
      }
      const lastWrite = hunk.items.map((it, ix) => (it.k === 'c' || it.k === 'n' ? ix : -1)).reduce((x, y) => Math.max(x, y), -1);
      const noBreak = lastWrite >= 0 && hunk.items[lastWrite + 1]?.k === 'b';
      if (o.length === 0) {
        const pos = Math.min(hunk.a + d, st.lines.length);
        const resolved = resolveN(entries, st.lines, pos, o, 0);
        const atEnd = pos === st.lines.length;
        st.lines.splice(pos, 0, ...resolved);
        if (atEnd) st.ends = !noBreak;
        d += resolved.length;
        continue;
      }
      const hit = findTier(st.lines, o, strict);
      if (hit === null) throw new Fail('no-match', oldP);
      const target = hunk.a - 1 + d;
      let pos = hit.positions[0]!;
      for (const p of hit.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const resolved = resolveN(entries, st.lines, pos, o, hit.tier);
      const reachesEnd = pos + o.length === st.lines.length;
      st.lines = [...st.lines.slice(0, pos), ...resolved, ...st.lines.slice(pos + o.length)];
      if (reachesEnd) st.ends = !noBreak;
      d += resolved.length - o.length;
    }
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, joinState(st));
      tree.moves.push({ from: oldP, to: newP });
    } else {
      tree.now.set(oldP, joinState(st));
    }
  };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections = unifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(unifiedEdit);
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceBlocks(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let searchFrom = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    let end = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevPath = path;
    searchFrom = end + 1;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const blocks = searchReplaceBlocks(lines);
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b): Edit => {
    return (tree: Tree, strict = false) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const st = splitState(before);
      const hit = findTier(st.lines, b.oldLines, strict);
      if (hit === null) throw new Fail('no-match', b.path);
      if (hit.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = hit.positions[0]!;
      const entries: NEntry[] = b.newLines.map((t) => ({ add: t }));
      const resolved = resolveN(entries, st.lines, pos, b.oldLines, hit.tier);
      st.lines = [...st.lines.slice(0, pos), ...resolved, ...st.lines.slice(pos + b.oldLines.length)];
      tree.now.set(b.path, joinState(st));
    };
  });
}

// ---------- V4A patches (SPEC section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: { k: 'c' | 'o' | 'n'; text: string; emptyLine: boolean }[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  addLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  const startChunk = (anchor: string | null): VChunk => {
    const c: VChunk = { anchor, eof: false, items: [] };
    cur!.chunks.push(c);
    chunk = c;
    return c;
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const isHead = line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
    if (isHead) {
      if (line.startsWith('*** Add File: ')) cur = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), line: i + 1, addLines: [], chunks: [] };
      else if (line.startsWith('*** Delete File: ')) cur = { kind: 'del', path: line.slice('*** Delete File: '.length).trim(), line: i + 1, addLines: [], chunks: [] };
      else cur = { kind: 'upd', path: line.slice('*** Update File: '.length).trim(), line: i + 1, addLines: [], chunks: [] };
      sections.push(cur);
      chunk = null;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push(line.slice(1));
      else if (line === '') cur.addLines.push('');
      else if (blank(line)) {
        // A whitespace-only line cannot be Add content (SPEC section 8: a line starts with '+' or is
        // empty). It only separates sections when nothing but blank lines follow it in this section,
        // so look ahead: does more '+' content follow before the next section header?
        let more = false;
        for (let j = i + 1; j < last; j += 1) {
          const ahead = lines[j]!;
          if (ahead.startsWith('*** Add File: ') || ahead.startsWith('*** Delete File: ') || ahead.startsWith('*** Update File: ')) break;
          if (ahead.startsWith('+')) { more = true; break; }
        }
        if (!more) continue; // trailing blank lines are not part of the section
        throw new Exit2(`error: parse ${i + 1}`); // content follows, so this line sits inside the section and is neither '+' nor empty
      }
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // update section
    if (line.startsWith('*** Move to: ')) {
      const isFirst = cur.chunks.length === 0 && cur.moveTo === undefined;
      if (!isFirst) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      startChunk(anchorText === '' ? null : anchorText);
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) chunk = startChunk(null);
      chunk.eof = true;
      chunk = null;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (chunk === null) chunk = startChunk(null);
      if (line.startsWith(' ')) chunk.items.push({ k: 'c', text: line.slice(1), emptyLine: false });
      else if (line.startsWith('-')) chunk.items.push({ k: 'o', text: line.slice(1), emptyLine: false });
      else if (line.startsWith('+')) chunk.items.push({ k: 'n', text: line.slice(1), emptyLine: false });
      else chunk.items.push({ k: 'c', text: '', emptyLine: true });
      continue;
    }
    if (blank(line)) continue;
    throw new Exit2(`error: parse ${i + 1}`);
  }
  for (const s of sections) {
    if (s.kind === 'add') {
      while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1] === '') s.addLines.pop();
    }
    if (s.kind === 'upd') {
      // Blank lines at the end of a section are not part of it (SPEC section 8, with
      // section 4's blank: empty or only whitespace), so drop the last chunk's trailing
      // context items whose text is empty, however they were written (' ' or '').
      const lastChunk = s.chunks[s.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.items.length > 0) {
          const tail = lastChunk.items[lastChunk.items.length - 1]!;
          if (tail.k === 'c' && tail.text === '') lastChunk.items.pop();
          else break;
        }
      }
      if (s.chunks.length === 0 && s.moveTo === undefined) throw new Exit2(`error: parse ${s.line}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(lines: string[]): Edit[] {
  const sections = v4aSections(lines);
  return sections.map((s): Edit => {
    return (tree: Tree, strict = false) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (s.kind === 'add') {
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
        return;
      }
      if (s.kind === 'del') {
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
        return;
      }
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const st = splitState(before);
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          let found = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const tier of tiers) {
            for (let ix = cursor; ix < st.lines.length; ix += 1) {
              if (lineEq(st.lines[ix]!, ch.anchor, tier)) {
                found = ix;
                break;
              }
            }
            if (found >= 0) break;
          }
          if (found < 0) throw new Fail('no-match', s.path);
          cursor = found + 1;
        }
        const o: string[] = [];
        const entries: NEntry[] = [];
        for (const it of ch.items) {
          if (it.k === 'c') {
            o.push(it.text);
            entries.push({ ctx: o.length - 1 });
          } else if (it.k === 'o') o.push(it.text);
          else entries.push({ add: it.text });
        }
        if (o.length === 0) {
          const pos = ch.eof ? st.lines.length : Math.min(cursor, st.lines.length);
          const resolved = resolveN(entries, st.lines, pos, o, 0);
          st.lines.splice(pos, 0, ...resolved);
          cursor = pos + resolved.length;
          continue;
        }
        const hit = findTier(st.lines, o, strict, cursor, ch.eof);
        if (hit === null) throw new Fail('no-match', s.path);
        const pos = hit.positions[0]!;
        const resolved = resolveN(entries, st.lines, pos, o, hit.tier);
        st.lines = [...st.lines.slice(0, pos), ...resolved, ...st.lines.slice(pos + o.length)];
        cursor = pos + resolved.length;
      }
      if (s.moveTo !== undefined) {
        tree.now.set(s.path, null);
        tree.now.set(s.moveTo, joinState(st));
        tree.moves.push({ from: s.path, to: s.moveTo });
      } else {
        tree.now.set(s.path, joinState(st));
      }
    };
  });
}

// ---------- invocation, output, atomic write (SPEC sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      (edit as (t: Tree, s: boolean) => void)(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths and their report lines; a recorded move collapses its D/A pair into one R line.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const mv of tree.moves) {
    const finalFrom = tree.now.has(mv.from) ? tree.now.get(mv.from)! : tree.original(mv.from);
    const finalTo = tree.now.has(mv.to) ? tree.now.get(mv.to)! : tree.original(mv.to);
    const fromGone = tree.original(mv.from) !== null && finalFrom === null;
    const toNew = tree.original(mv.to) === null && finalTo !== null;
    if (fromGone && toNew && mv.from !== mv.to) {
      movedFrom.add(mv.from);
      movedTo.add(mv.to);
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
    }
  }
  for (const p of changed) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
