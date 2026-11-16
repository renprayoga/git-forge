// Git smart-HTTP: protocol v2 and v0 upload-pack, v0 receive-pack.
// Written from scratch for this entry, against the kit's wire contract.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

export function pktLinesOf(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------- ref helpers

export interface RefInfo {
  name: string;
  oid: string;
}

export function sortedRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

export function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

function peelOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') return parseTag(obj.data).object;
  return null;
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'forge/1.0';

function v2Advertisement(): Buffer {
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'server-option\n',
  ];
  const parts = [pktLine(lines[0]), pktFlush()];
  for (const line of lines.slice(1)) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const tip = defaultTip(repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`
      : `report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`;
  const parts = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = tip ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peelOid(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): Buffer {
  if (service === 'git-upload-pack' && wantV2) return v2Advertisement();
  return v0Advertisement(repo, service);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  send: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/** Objects reachable from `tips`, not descending past `stopAt` oids (their own objects included). */
function reachableBounded(
  repo: Repo,
  tips: readonly string[],
  stopAt: ReadonlySet<string>,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (stopAt.has(oid)) continue;
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

/** Commits at each generation from wants (generation 0 = the wants themselves).
 *  Stops after `limit` generations when given: a depth fetch only ever needs
 *  the first `depth` generations, and walking a 200-commit history for a
 *  depth-1 clone is pure waste. */
function generations(
  repo: Repo,
  wants: readonly string[],
  limit?: number,
): Array<Set<string>> {
  const gens: Array<Set<string>> = [];
  const seen = new Set<string>();
  // Peel annotated tags to the commit they point at.
  const peeled = wants.map((w) => {
    const obj = repo.objects.get(w);
    return obj?.type === 'tag' ? parseTag(obj.data).object : w;
  });
  let current = new Set(peeled.filter((w) => repo.objects.get(w)?.type === 'commit'));
  while (current.size > 0) {
    gens.push(current);
    if (limit !== undefined && gens.length >= limit) break;
    const next = new Set<string>();
    for (const oid of current) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) if (!seen.has(p)) next.add(p);
    }
    current = next;
  }
  return gens;
}

export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string) => repo.objects.get(oid);
  const shallowSet = new Set(shallowBoundaries);
  const haveObjects = reachableBounded(repo, haves, shallowSet);
  let wanted: Map<string, GitObject>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null) {
    const gens = generations(repo, wants, depth);
    const included = new Set<string>();
    for (let g = 0; g < Math.min(depth, gens.length); g++) {
      for (const oid of gens[g]!) included.add(oid);
    }
    // A tag want contributes the tag object itself.
    for (const w of wants) if (repo.objects.get(w)?.type === 'tag') included.add(w);
    // Shallow boundary: the deepest generation INCLUDED — the commits whose
    // parents are cut off (git records these in .git/shallow). No boundary
    // when the whole history fits inside the depth.
    if (gens.length >= depth) {
      for (const oid of gens[depth - 1]!) shallow.push(oid);
    }
    // Any commit in the wanted set that was a shallow boundary before is now unshallow.
    for (const b of shallowBoundaries) if (included.has(b)) unshallow.push(b);
    // Wanted objects: the included commits plus the trees/blobs reachable
    // from them — but NEVER their parents. Descending into parents is what
    // leaked history past the depth boundary.
    wanted = new Map<string, GitObject>();
    const stack = [...included];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = lookup(oid);
      if (!obj) continue;
      wanted.set(oid, obj);
      if (obj.type === 'commit') {
        stack.push(parseCommit(obj.data).tree);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  } else {
    wanted = collectReachable(wants, lookup);
  }
  const send = new Map<string, GitObject>();
  for (const [oid, obj] of wanted) if (!haveObjects.has(oid)) send.set(oid, obj);
  return { send, shallow, unshallow };
}

export function packFor(repo: Repo, plan: FetchPlan, cacheKey: string): Buffer {
  const cached = repo.packCache.get(cacheKey);
  if (cached) return cached;
  const pack = writePack(plan.send.values());
  repo.packCache.set(cacheKey, pack);
  return pack;
}

// ---------------------------------------------------------------- upload-pack v2

export function handleLsRefs(repo: Repo, packets: readonly Pkt[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim || p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = sortedRefs(repo);
  const tip = defaultTip(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((x) => name.startsWith(x));
  const parts: Buffer[] = [];
  const emit = (oid: string, name: string, attrs: string): void => {
    parts.push(pktLine(`${oid} ${name}${attrs}\n`));
  };
  // HEAD is reported when symrefs/unborn was asked for and HEAD is in scope:
  // no prefixes, or a prefix that HEAD itself matches (e.g. git clone asks
  // for ref-prefix HEAD). A non-matching prefix excludes HEAD entirely.
  const headInScope = prefixes.length === 0 || prefixes.some((x) => 'HEAD'.startsWith(x));
  if (headInScope && (symrefs || unborn)) {
    if (tip) emit(tip, 'HEAD', ` symref-target:refs/heads/${repo.defaultBranch}`);
    else if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let attrs = '';
    if (peel) {
      const peeled = peelOid(repo, ref.oid);
      if (peeled) attrs += ` peeled:${peeled}`;
    }
    emit(ref.oid, ref.name, attrs);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleFetchV2(repo: Repo, packets: readonly Pkt[]): Buffer {
  let thinPack = false;
  let ofsDelta = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim || p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line === 'thin-pack') thinPack = true;
    else if (line === 'ofs-delta') ofsDelta = true;
    else if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  void thinPack;
  void ofsDelta;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const cacheKey = `v2|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}|${repo.version}`;
  const pack = packFor(repo, plan, cacheKey);
  const parts: Buffer[] = [];
  // Real git expects an acknowledgments section only when the client sent
  // haves; with no haves the first section must be shallow-info or packfile.
  // (The kit's client accepts either order.)
  if (haves.length > 0) parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  // Sideband band 1, chunked to <= 65520 bytes of payload per pkt-line.
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(framed));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, packets: readonly Pkt[]): Buffer {
  const lines = pktLinesOf(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const cacheKey = `v0|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}|${repo.version}`;
  const pack = packFor(repo, plan, cacheKey);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushReportEntry {
  ref: string;
  ok: boolean;
  reason: string;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const packets = parsePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  // Find where the pkt-line section ends (first flush) — the pack follows it.
  {
    let i = 0;
    while (i + 4 <= body.length) {
      const head = body.subarray(i, i + 4).toString('ascii');
      if (head === '0000') {
        packStart = i + 4;
        break;
      }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || i + len > body.length) break;
      i += len;
    }
  }
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const cmd = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = cmd.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let incoming = new Map<string, GitObject>();
  if (hasUpdates && packStart < body.length) {
    try {
      incoming = readPack(body.subarray(packStart));
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const report: PushReportEntry[] = [];
  if (unpackOk) {
    for (const [oid, obj] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    const lookup = (oid: string) => repo.objects.get(oid);
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined || current !== cmd.oldOid) {
          if (current === undefined && cmd.oldOid === ZERO_OID) {
            report.push({ ref: cmd.ref, ok: false, reason: 'failed to delete ref' });
          } else {
            report.push({ ref: cmd.ref, ok: false, reason: 'failed to delete ref' });
          }
          continue;
        }
        repo.refs.delete(cmd.ref);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          report.push({ ref: cmd.ref, ok: false, reason: 'failed to update ref' });
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      // existing ref: old must match, new must be a descendant (fast-forward)
      if (current !== cmd.oldOid) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (!isAncestor(current, cmd.newOid, lookup)) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, ok: true, reason: '' });
    }
    if (report.some((r) => r.ok)) {
      repo.version += 1;
      repo.advCache.clear();
      repo.packCache.clear();
    }
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const r of report) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  // The report-status stream is itself a pkt-line stream and must end with a
  // flush: the client's packet reader dies on EOF ("the remote end hung up")
  // if it does not see one. It rides inside sideband band 1; the outer flush
  // ends the HTTP response.
  const inner = Buffer.concat([...reportLines.map((l) => pktLine(l)), pktFlush()]);
  const out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()]);
  void store;
  void createHash;
  void deflateSync;
  void mergeBase;
  return { status: 200, body: out };
}
