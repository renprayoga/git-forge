// The forge's in-memory store: git objects, packs, repositories, issues and pull requests.
// Written from scratch for this entry. No git binary, no dependencies, node stdlib only.

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

// ---------------------------------------------------------------- SHA-1 objects

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const p of fields.parents) lines.push(`parent ${p}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function ident(login: string, when: Date): string {
  const ts = Math.floor(when.getTime() / 1000);
  return `${login} <${login}@example.invalid> ${ts} +0000`;
}

// ---------------------------------------------------------------- packs

const PACK_TYPES: Record<number, ObjType | 'ofs-delta' | 'ref-delta'> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  chunks.push(head);
  for (const obj of list) {
    chunks.push(packObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    chunks.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
}

function readVarint(buf: Buffer, start: number): { size: number; typeCode: number; next: number } {
  let i = start;
  let b = buf[i];
  const typeCode = (b >> 4) & 0x7;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    i += 1;
    b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { size, typeCode, next: i + 1 };
}

function readOfsDelta(buf: Buffer, start: number): { offset: number; next: number } {
  let i = start;
  let b = buf[i];
  let offset = b & 0x7f;
  while (b & 0x80) {
    i += 1;
    b = buf[i];
    offset = ((offset + 1) << 7) | (b & 0x7f);
  }
  return { offset, next: i + 1 };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[i++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const dstSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let k = 0; k < 4; k++) if (op & (1 << k)) off |= delta[i++] << (k * 8);
      for (let k = 0; k < 3; k++) if (op & (0x10 << k)) size |= delta[i++] << (k * 8);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
      total += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expect = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const deltas: Array<{ offset: number; baseOffset: number; baseOid: string | null; data: Buffer; type: ObjType }> = [];
  let pos = 12;
  for (let n = 0; n < count; n++) {
    const start = pos;
    const { size, typeCode, next } = readVarint(pack, pos);
    pos = next;
    const typeName = PACK_TYPES[typeCode];
    if (typeName === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    if (typeName === 'ofs-delta' || typeName === 'ref-delta') {
      let baseOffset = -1;
      let baseOid: string | null = null;
      if (typeName === 'ofs-delta') {
        const r = readOfsDelta(pack, pos);
        baseOffset = start - r.offset;
        pos = r.next;
      } else {
        baseOid = pack.subarray(pos, pos + 20).toString('hex');
        pos += 20;
      }
      const data = inflateSync(pack.subarray(pos));
      // advance pos by the compressed length: re-deflate is not possible; find it by trial inflate with dictionary? Use zlib inflate with end position via raw approach:
      pos = skipDeflate(pack, pos);
      deltas.push({ offset: start, baseOffset, baseOid, data, type: 'blob' });
      void size;
    } else {
      const data = inflateSync(pack.subarray(pos));
      pos = skipDeflate(pack, pos);
      const obj: GitObject = { type: typeName as ObjType, data };
      const oid = hashObject(obj.type, obj.data);
      byOffset.set(start, obj);
      byOid.set(oid, obj);
    }
  }
  // Resolve deltas (possibly chained): iterate until all resolve.
  let pending = deltas;
  for (let round = 0; round < pending.length + 2 && pending.length > 0; round++) {
    const next: typeof pending = [];
    for (const d of pending) {
      let base: GitObject | undefined;
      if (d.baseOffset >= 0) base = byOffset.get(d.baseOffset);
      else if (d.baseOid) base = byOid.get(d.baseOid);
      if (!base) {
        next.push(d);
        continue;
      }
      const data = applyDelta(base.data, d.data);
      const obj: GitObject = { type: base.type, data };
      const oid = hashObject(obj.type, obj.data);
      byOffset.set(d.offset, obj);
      byOid.set(oid, obj);
    }
    if (next.length === pending.length) throw new Error('unresolvable pack delta');
    pending = next;
  }
  return byOid;
}

/** Advance past one zlib stream starting at `pos` by inflating with a bounded window. */
function skipDeflate(buf: Buffer, pos: number): number {
  // Inflate incrementally in chunks to find where the stream ends.
  // Node's inflateSync consumes the whole tail; instead use a manual approach:
  // try increasing end positions is too slow for large packs, so use zlib's
  // inflate with `info` via a small helper: inflateSync on a slice and check
  // the unused bytes by re-inflating slices with binary search on length.
  let lo = pos;
  let hi = buf.length;
  // Find the smallest end such that inflateSync(buf[pos:end]) succeeds and
  // the result length matches the stream's own end. Binary search on end.
  const tryEnd = (end: number): boolean => {
    try {
      inflateSync(buf.subarray(pos, end));
      return true;
    } catch {
      return false;
    }
  };
  if (!tryEnd(hi)) throw new Error('corrupt deflate stream in pack');
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (tryEnd(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------- reachability

export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

export function isAncestor(ancestor: string, tip: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// ---------------------------------------------------------------- store

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string; color: string }>;
  userLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Array<{ id: number; body: string; userLogin: string; createdAt: string }>;
  cachedJson: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  userLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  flatCache: Map<string, Map<string, { oid: string; mode: string }>>;
  advCache: Map<string, Buffer>;
  packCache: Map<string, Buffer>;
}

export class Store {
  viewerLogin: string | null = null;
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextGlobalId = 100000;
  seq = 0;
  requestSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  bindViewer(owner: string): string {
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      // Re-key repos created before the viewer was known.
      for (const [k, repo] of [...this.repos]) {
        if (repo.owner === '') {
          this.repos.delete(k);
          repo.owner = owner;
          this.repos.set(this.key(owner, repo.name), repo);
        }
      }
    }
    return this.viewerLogin;
  }

  viewer(): string {
    return this.viewerLogin ?? 'forge-user';
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: now,
      updatedAt: now,
      version: 0,
      flatCache: new Map(),
      advCache: new Map(),
      packCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  newRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}-${randomUUID().slice(0, 8)}`;
  }

  // --- git helpers on a repo ---

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Flatten a commit's tree to path -> {oid, mode}, memoized per tree oid.
   *  The returned map is shared with the cache: callers must NOT mutate it. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const cached = repo.flatCache.get(treeOid + '\0' + prefix);
    if (cached) return cached;
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, e.oid, path)) out.set(p, v);
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
    repo.flatCache.set(treeOid + '\0' + prefix, out);
    return out;
  }

  flattenCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(obj.data).tree);
  }

  /** Build a tree object from a path->blob map, bottom up. Returns root tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, v] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i]!;
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1]!, v);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, v] of [...node.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ mode: v.mode, name, oid: v.oid });
      }
      for (const [name, child] of [...node.dirs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Commit a file map on a branch tip (or as the root commit). Returns the new commit oid. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: Map<string, { oid: string; mode: string }>,
    message: string,
    login: string,
  ): string {
    const tree = this.buildTreeFromFiles(repo, files);
    const now = new Date();
    const parents: string[] = [];
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip) parents.push(tip);
    const author = ident(login, now);
    // Store the message verbatim: callers compare it back exactly.
    const data = buildCommit({ tree, parents, author, committer: author, message });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.version += 1;
    repo.advCache.clear();
    repo.packCache.clear();
    return oid;
  }

  /** List commits reachable from a tip, newest first (BFS by discovery, linear histories stay in order). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return out;
  }

  /** Diff two file maps. Returns changed paths with status and line counts. */
  diffFiles(
    repo: Repo,
    base: Map<string, { oid: string; mode: string }>,
    head: Map<string, { oid: string; mode: string }>,
  ): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      const countLines = (oid: string): number => {
        const o = repo.objects.get(oid);
        if (!o) return 0;
        const text = o.data.toString('utf8');
        return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      };
      if (!b && h) {
        const add = countLines(h.oid);
        out.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
      } else if (b && !h) {
        const del = countLines(b.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
      } else if (b && h) {
        const add = countLines(h.oid);
        const del = countLines(b.oid);
        out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    return out;
  }

  /** True when merging head into base would conflict (same path changed on both sides since merge-base). */
  hasConflict(repo: Repo, baseRef: string, headRef: string): boolean {
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`) ?? repo.refs.get(baseRef);
    const headTip = repo.refs.get(`refs/heads/${headRef}`) ?? repo.refs.get(headRef);
    if (!baseTip || !headTip) return false;
    const mb = mergeBase(baseTip, headTip, this.lookup(repo));
    if (mb === null) return false;
    const mbFiles = this.flattenCommit(repo, mb);
    const baseFiles = this.flattenCommit(repo, baseTip);
    const headFiles = this.flattenCommit(repo, headTip);
    const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const m = mbFiles.get(path)?.oid;
      const b = baseFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const baseChanged = b !== m;
      const headChanged = h !== m;
      if (baseChanged && headChanged && b !== h) return true;
    }
    return false;
  }

  globalId(kind: string, ref: string): string {
    return Buffer.from(`${kind}:${ref}`, 'utf8').toString('base64url');
  }

  decodeGlobalId(id: string): { kind: string; ref: string } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const i = text.indexOf(':');
      if (i <= 0) return null;
      return { kind: text.slice(0, i), ref: text.slice(i + 1) };
    } catch {
      return null;
    }
  }
}
