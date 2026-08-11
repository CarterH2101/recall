import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import {
  GENESIS_PREV,
  aesGcmOpen,
  aesGcmSeal,
  decryptOpV2,
  deriveMetaKey,
  deriveNameKey,
  encryptOpV2,
  generateMemberKeys,
  lockboxSigPayload,
  makeBindSig,
  newTeamKey,
  openLockbox,
  opSigPayload,
  recordHash,
  sealLockbox,
  sha256,
  signPayload,
  signRecord,
  signRequest,
  verifyBindSig,
  verifyChain,
  verifyPayload,
  type MemberKeys,
  type TeamRecord,
} from "./crypto2.js";
import {
  applyRemoteFact,
  decryptOp as decryptOpV1,
  gateContent,
  neutralizePaths,
  opId as makeOpId,
  saveSyncConfig,
  syncConfigPath,
  type PushResult,
  type PullResult,
  type WireFact,
} from "./sync.js";
import type { Fact } from "./facts.js";

// Team sync v2 protocol client. Per-member Ed25519/X25519 identity, admin-
// signed hash-chained membership records, generation-based team keys. The
// hub authenticates signed requests and stores ciphertext + public keys; all
// decryption (ops, member names) happens here.

export interface TeamConfigV2 {
  v: 2;
  serverUrl: string;
  teamId: string;
  deviceId: string;
  memberId: string;
  name: string;
  signPriv: string;
  signPub: string;
  boxPriv: string;
  boxPub: string;
  adminSignPub: string; // pinned root of trust (from the invite / genesis)
  isAdmin: boolean;
  adminSignPriv?: string;
  issuedInvites: Record<string, string>; // inviteHash -> joinSecret (admin)
  gens: Record<string, string>; // gen -> TK (base64)
  currentGen: number;
  recordsHead: { seq: number; hash: string };
  pending?: boolean;
}

export function isV2(cfg: any): cfg is TeamConfigV2 {
  return cfg && cfg.v === 2;
}

function save(cfg: TeamConfigV2): void {
  saveSyncConfig(cfg as any);
}

/* ---------- signed HTTP ---------- */

async function api2(cfg: TeamConfigV2, method: string, pathname: string, body?: unknown): Promise<any> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = new Date().toISOString();
  const res = await fetch(`${cfg.serverUrl.replace(/\/$/, "")}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Recall-Member": cfg.memberId,
      "X-Recall-Ts": ts,
      "X-Recall-Sig": signRequest(cfg.signPriv, method, pathname, ts, raw),
    },
    body: raw || undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(`${method} ${pathname}: ${(json as any).error ?? res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/* ---------- name encryption (E2E metadata riding the record chain) ---------- */

function sealName(cfg: TeamConfigV2, gen: number, memberId: string, name: string): string {
  const key = deriveMetaKey(cfg.gens[String(gen)], cfg.teamId);
  return aesGcmSeal(key, `${cfg.teamId}|name|${memberId}`, Buffer.from(name, "utf8")).toString("base64");
}

function openName(cfg: TeamConfigV2, gen: number, memberId: string, nameEncB64: string): string | null {
  const tk = cfg.gens[String(gen)];
  if (!tk) return null;
  try {
    return aesGcmOpen(deriveMetaKey(tk, cfg.teamId), `${cfg.teamId}|name|${memberId}`, Buffer.from(nameEncB64, "base64")).toString("utf8");
  } catch {
    return null;
  }
}

/* ---------- create / invite / join ---------- */

export async function createTeamV2(serverUrl: string, name: string, displayName: string): Promise<TeamConfigV2> {
  const admin = generateMemberKeys();
  const teamId = randomUUID();
  const tk1 = newTeamKey();
  const cfg: TeamConfigV2 = {
    v: 2,
    serverUrl,
    teamId,
    deviceId: randomUUID(),
    memberId: admin.memberId,
    name: displayName,
    signPriv: admin.signPriv,
    signPub: admin.signPub,
    boxPriv: admin.boxPriv,
    boxPub: admin.boxPub,
    adminSignPub: admin.signPub,
    isAdmin: true,
    adminSignPriv: admin.signPriv,
    issuedInvites: {},
    gens: { "1": tk1 },
    currentGen: 1,
    recordsHead: { seq: 0, hash: GENESIS_PREV },
  };

  const genesis = signRecord(
    teamId,
    {
      seq: 1,
      kind: "genesis",
      body: {
        adminPub: admin.signPub,
        adminMemberId: admin.memberId,
        gen: 1,
        nameEnc: sealName(cfg, 1, admin.memberId, displayName),
      },
      prevHash: GENESIS_PREV,
    },
    admin.signPriv,
  );
  const box = sealLockbox(teamId, 1, admin.memberId, admin.boxPub, tk1);
  const boxSig = signPayload(admin.signPriv, lockboxSigPayload(teamId, 1, admin.memberId, box));

  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/teams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      teamId,
      name,
      adminSignPub: admin.signPub,
      adminMember: {
        signPub: admin.signPub,
        boxPub: admin.boxPub,
        bindSig: makeBindSig(teamId, admin.boxPub, admin.signPriv),
      },
      genesisRecord: genesis,
      lockbox: { box, boxSig },
    }),
  });
  if (!res.ok) throw new Error(`team creation failed: ${res.status} ${await res.text()}`);

  cfg.recordsHead = { seq: 1, hash: recordHash(teamId, genesis) };
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sync_state (team_id, last_seq) VALUES (?, 0)`).run(teamId);
  db.prepare(
    `INSERT OR REPLACE INTO team_members (member_id, name, sign_pub, role, status) VALUES (?, ?, ?, 'admin', 'active')`,
  ).run(admin.memberId, displayName, admin.signPub);
  save(cfg);
  return cfg;
}

export interface InviteCode {
  u: string; // server url
  t: string; // team id
  a: string; // admin sign pub (pinned by the joiner)
  j: string; // join secret (base64url)
}

export async function issueInvite(cfg: TeamConfigV2, expiresHours = 168): Promise<string> {
  if (!cfg.isAdmin) throw new Error("only the admin can issue invites");
  const joinSecret = randomBytes(24).toString("base64url");
  const inviteHash = sha256(joinSecret).toString("hex");
  await api2(cfg, "POST", `/v1/${cfg.teamId}/invites`, {
    inviteHash,
    expiresAt: new Date(Date.now() + expiresHours * 3600_000).toISOString(),
  });
  cfg.issuedInvites[inviteHash] = joinSecret;
  save(cfg);
  const code: InviteCode = { u: cfg.serverUrl, t: cfg.teamId, a: cfg.adminSignPub, j: joinSecret };
  return Buffer.from(JSON.stringify(code)).toString("base64url");
}

export async function joinTeamV2(codeB64url: string, displayName?: string): Promise<TeamConfigV2> {
  const code: InviteCode = JSON.parse(Buffer.from(codeB64url.trim(), "base64url").toString("utf8"));
  if (!code.u || !code.t || !code.a || !code.j) throw new Error("malformed invite");
  const keys: MemberKeys = generateMemberKeys();
  const name = displayName || os.userInfo().username;

  const nameKey = deriveNameKey(code.j, code.t);
  const nameBox = aesGcmSeal(nameKey, `${code.t}|joinname|${keys.memberId}`, Buffer.from(name, "utf8")).toString("base64");

  const res = await fetch(`${code.u.replace(/\/$/, "")}/v1/${code.t}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      joinSecret: code.j,
      signPub: keys.signPub,
      boxPub: keys.boxPub,
      bindSig: makeBindSig(code.t, keys.boxPub, keys.signPriv),
      nameBox,
    }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);

  const cfg: TeamConfigV2 = {
    v: 2,
    serverUrl: code.u,
    teamId: code.t,
    deviceId: randomUUID(),
    memberId: keys.memberId,
    name,
    signPriv: keys.signPriv,
    signPub: keys.signPub,
    boxPriv: keys.boxPriv,
    boxPub: keys.boxPub,
    adminSignPub: code.a,
    isAdmin: false,
    issuedInvites: {},
    gens: {},
    currentGen: 0,
    recordsHead: { seq: 0, hash: GENESIS_PREV },
    pending: true,
  };
  getDb().prepare(`INSERT OR IGNORE INTO sync_state (team_id, last_seq) VALUES (?, 0)`).run(code.t);
  save(cfg);
  return cfg;
}

/* ---------- state sync: lockboxes + records + pending queue ---------- */

export async function refreshTeamState(cfg: TeamConfigV2): Promise<{ status: string }> {
  const me = await api2(cfg, "GET", `/v1/${cfg.teamId}/me`);
  cfg.pending = me.status === "pending";
  if (me.status === "pending") {
    save(cfg);
    return { status: "pending" };
  }

  // 1. Lockboxes (admin-signature-verified, so safe to unwrap pre-chain).
  const boxes = (await api2(cfg, "GET", `/v1/${cfg.teamId}/lockboxes`)) as any[];
  for (const lb of boxes) {
    if (cfg.gens[String(lb.gen)]) continue;
    if (!verifyPayload(cfg.adminSignPub, lockboxSigPayload(cfg.teamId, lb.gen, cfg.memberId, lb.box), lb.box_sig)) {
      throw new Error(`lockbox for gen ${lb.gen} failed admin-signature verification — possible server tampering`);
    }
    cfg.gens[String(lb.gen)] = openLockbox(cfg.teamId, lb.gen, cfg.memberId, cfg.boxPriv, lb.box);
  }

  // 2. Records: fetch, verify the chain from our stored head, apply.
  const db = getDb();
  const r = await api2(cfg, "GET", `/v1/${cfg.teamId}/records?since=${cfg.recordsHead.seq}`);
  const records: TeamRecord[] = r.records ?? [];
  if (records.length) {
    verifyChain(cfg.teamId, records, cfg.adminSignPub, cfg.recordsHead.seq ? cfg.recordsHead : undefined);
    const upsertMember = db.prepare(
      `INSERT INTO team_members (member_id, name, sign_pub, role, status) VALUES (?, ?, ?, ?, 'active')
       ON CONFLICT(member_id) DO UPDATE SET name = COALESCE(excluded.name, team_members.name), status = 'active'`,
    );
    for (const rec of records) {
      if (rec.kind === "genesis") {
        const nm = rec.body.nameEnc ? openName(cfg, rec.body.gen ?? 1, rec.body.adminMemberId, rec.body.nameEnc) : null;
        db.prepare(
          `INSERT INTO team_members (member_id, name, sign_pub, role, status) VALUES (?, ?, ?, 'admin', 'active')
           ON CONFLICT(member_id) DO UPDATE SET name = COALESCE(excluded.name, team_members.name)`,
        ).run(rec.body.adminMemberId, nm, rec.body.adminPub);
      } else if (rec.kind === "member_add") {
        const nm = rec.body.nameEnc ? openName(cfg, rec.body.gen, rec.body.memberId, rec.body.nameEnc) : null;
        upsertMember.run(rec.body.memberId, nm, rec.body.signPub ?? "", "member");
      } else if (rec.kind === "member_revoke") {
        db.prepare(`UPDATE team_members SET status = 'revoked' WHERE member_id = ?`).run(rec.body.memberId);
        if (typeof rec.body.gen === "number") cfg.currentGen = rec.body.gen;
      } else if (rec.kind === "rotate") {
        cfg.currentGen = rec.body.gen;
      }
      cfg.recordsHead = { seq: rec.seq, hash: recordHash(cfg.teamId, rec) };
    }
    db.prepare(`UPDATE sync_state SET last_rec_seq = ? WHERE team_id = ?`).run(cfg.recordsHead.seq, cfg.teamId);
  }
  if (!cfg.currentGen) cfg.currentGen = me.currentGen;
  // Late name decryption: gens may have arrived after the records did.
  save(cfg);
  return { status: "active" };
}

/** Admin: approve pending joiners — verify, decrypt their name with the
 *  issued joinSecret, publish a signed member_add + lockboxes for every gen. */
export async function drainPending(cfg: TeamConfigV2): Promise<number> {
  if (!cfg.isAdmin || !cfg.adminSignPriv) return 0;
  const pending = (await api2(cfg, "GET", `/v1/${cfg.teamId}/pending`)) as any[];
  let approved = 0;
  for (const p of pending) {
    if (!verifyBindSig(cfg.teamId, p.box_pub, p.sign_pub, p.bind_sig)) {
      console.error(`[team] pending member ${p.member_id}: bad bindSig — skipped`);
      continue;
    }
    let name: string | null = null;
    const joinSecret = p.invite_hash ? cfg.issuedInvites[p.invite_hash] : undefined;
    if (joinSecret && p.name_box) {
      try {
        name = aesGcmOpen(
          deriveNameKey(joinSecret, cfg.teamId),
          `${cfg.teamId}|joinname|${p.member_id}`,
          Buffer.from(p.name_box, "base64"),
        ).toString("utf8");
      } catch {
        name = null;
      }
    }

    const rec = signRecord(
      cfg.teamId,
      {
        seq: cfg.recordsHead.seq + 1,
        kind: "member_add",
        body: {
          memberId: p.member_id,
          signPub: p.sign_pub,
          gen: cfg.currentGen,
          nameEnc: name ? sealName(cfg, cfg.currentGen, p.member_id, name) : null,
        },
        prevHash: cfg.recordsHead.hash,
      },
      cfg.adminSignPriv,
    );
    // New members can read full history: lockbox every generation we hold.
    const lockboxes = Object.entries(cfg.gens).map(([g, tk]) => {
      const gen = Number(g);
      const box = sealLockbox(cfg.teamId, gen, p.member_id, p.box_pub, tk);
      return { gen, memberId: p.member_id, box, boxSig: signPayload(cfg.adminSignPriv!, lockboxSigPayload(cfg.teamId, gen, p.member_id, box)) };
    });
    await api2(cfg, "POST", `/v1/${cfg.teamId}/records`, { record: rec, lockboxes });
    cfg.recordsHead = { seq: rec.seq, hash: recordHash(cfg.teamId, rec) };
    getDb()
      .prepare(
        `INSERT INTO team_members (member_id, name, sign_pub, role, status) VALUES (?, ?, ?, 'member', 'active')
         ON CONFLICT(member_id) DO UPDATE SET name = COALESCE(excluded.name, team_members.name), status = 'active'`,
      )
      .run(p.member_id, name, p.sign_pub);
    approved++;
  }
  if (approved) save(cfg);
  return approved;
}

/* ---------- rotate / revoke ---------- */

export async function rotateTeam(cfg: TeamConfigV2, revokeMemberId?: string): Promise<number> {
  if (!cfg.isAdmin || !cfg.adminSignPriv) throw new Error("only the admin can rotate/revoke");
  await refreshTeamState(cfg);
  const newGen = cfg.currentGen + 1;
  const tk = newTeamKey();

  const members = (await api2(cfg, "GET", `/v1/${cfg.teamId}/members`)) as any[];
  const recipients = members.filter((m) => m.status === "active" && m.member_id !== revokeMemberId);
  const lockboxes = recipients.map((m) => {
    const box = sealLockbox(cfg.teamId, newGen, m.member_id, m.box_pub, tk);
    return {
      gen: newGen,
      memberId: m.member_id,
      box,
      boxSig: signPayload(cfg.adminSignPriv!, lockboxSigPayload(cfg.teamId, newGen, m.member_id, box)),
    };
  });

  const rec = signRecord(
    cfg.teamId,
    revokeMemberId
      ? { seq: cfg.recordsHead.seq + 1, kind: "member_revoke", body: { memberId: revokeMemberId, gen: newGen }, prevHash: cfg.recordsHead.hash }
      : { seq: cfg.recordsHead.seq + 1, kind: "rotate", body: { gen: newGen }, prevHash: cfg.recordsHead.hash },
    cfg.adminSignPriv,
  );
  await api2(cfg, "POST", `/v1/${cfg.teamId}/records`, { record: rec, lockboxes });

  cfg.gens[String(newGen)] = tk;
  cfg.currentGen = newGen;
  cfg.recordsHead = { seq: rec.seq, hash: recordHash(cfg.teamId, rec) };
  save(cfg);
  if (revokeMemberId) {
    getDb().prepare(`UPDATE team_members SET status = 'revoked' WHERE member_id = ?`).run(revokeMemberId);
  }
  return newGen;
}

/* ---------- push / pull ---------- */

function buildWire(cfg: TeamConfigV2, f: Fact & { version: number }): WireFact {
  return {
    factId: f.id,
    factKind: f.kind,
    content: neutralizePaths(f.content),
    project: f.project,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    pinned: !!f.pinned,
    archived: !!f.archived,
    version: f.version,
    device: cfg.deviceId,
  };
}

export async function pushV2(cfg: TeamConfigV2): Promise<PushResult> {
  const db = getDb();
  const result: PushResult = { sent: 0, deduped: 0, blocked: [] };
  if (cfg.pending) return result;

  for (let attempt = 0; attempt < 2; attempt++) {
    const pendingFacts = db
      .prepare(`SELECT * FROM facts WHERE shared > 0 AND version > synced_version`)
      .all() as (Fact & { shared: number; version: number })[];
    result.blocked = [];

    const ops: any[] = [];
    const sendable: typeof pendingFacts = [];
    for (const f of pendingFacts) {
      const wire = buildWire(cfg, f);
      const gate = gateContent(wire.content, f.shared === 2);
      if (!gate.ok) {
        result.blocked.push({ factId: f.id, spans: gate.spans });
        continue;
      }
      const id = makeOpId(cfg.deviceId, f.id, f.version);
      const payload = encryptOpV2(cfg.gens[String(cfg.currentGen)], cfg.teamId, id, cfg.currentGen, cfg.memberId, wire);
      ops.push({
        op_id: id,
        device_id: cfg.deviceId,
        kind: f.archived ? "fact_archive" : "fact_put",
        key_gen: cfg.currentGen,
        payload: payload.toString("base64"),
        op_sig: signPayload(cfg.signPriv, opSigPayload(cfg.teamId, id, cfg.currentGen, payload)),
      });
      sendable.push(f);
    }
    // Curation labels ride the same encrypted channel.
    const pendingLabels = db
      .prepare(`SELECT * FROM fact_labels WHERE member_id = ? AND version > synced_version`)
      .all(cfg.memberId) as any[];
    for (const l of pendingLabels) {
      const id = `${cfg.deviceId}:label:${l.fact_id}:${l.version}`;
      const payload = encryptOpV2(cfg.gens[String(cfg.currentGen)], cfg.teamId, id, cfg.currentGen, cfg.memberId, {
        factId: l.fact_id,
        verdict: l.verdict,
        ts: l.ts,
      });
      ops.push({
        op_id: id,
        device_id: cfg.deviceId,
        kind: "fact_label",
        key_gen: cfg.currentGen,
        payload: payload.toString("base64"),
        op_sig: signPayload(cfg.signPriv, opSigPayload(cfg.teamId, id, cfg.currentGen, payload)),
      });
    }

    if (!ops.length) return result;

    try {
      const r = await api2(cfg, "POST", `/v1/${cfg.teamId}/ops`, { ops });
      const mark = db.prepare(`UPDATE facts SET synced_version = ? WHERE id = ?`);
      const markLabel = db.prepare(`UPDATE fact_labels SET synced_version = ? WHERE fact_id = ? AND member_id = ?`);
      const tx = db.transaction(() => {
        for (let i = 0; i < sendable.length; i++) {
          mark.run(sendable[i].version, sendable[i].id);
          if (r.results[i]?.deduped) result.deduped++;
          else result.sent++;
        }
        for (let i = 0; i < pendingLabels.length; i++) {
          markLabel.run(pendingLabels[i].version, pendingLabels[i].fact_id, cfg.memberId);
          if (r.results[sendable.length + i]?.deduped) result.deduped++;
          else result.sent++;
        }
      });
      tx();
      return result;
    } catch (e: any) {
      if (e.status === 409 && e.body?.error === "stale_gen" && attempt === 0) {
        await refreshTeamState(cfg); // pick up the new generation, re-encrypt
        continue;
      }
      throw e;
    }
  }
  return result;
}

export async function pullV2(cfg: TeamConfigV2): Promise<PullResult> {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sync_state (team_id, last_seq) VALUES (?, 0)`).run(cfg.teamId);
  const state = db.prepare(`SELECT last_seq FROM sync_state WHERE team_id = ?`).get(cfg.teamId) as any;
  const result: PullResult = { applied: 0, conflicts: 0, skippedOwn: 0, upTo: state.last_seq };
  if (cfg.pending) return result;

  const memberPub = db.prepare(`SELECT sign_pub FROM team_members WHERE member_id = ?`);

  for (;;) {
    const batch = await api2(cfg, "GET", `/v1/${cfg.teamId}/ops?since=${result.upTo}&limit=500`);
    if (!batch.ops.length) break;
    for (const op of batch.ops) {
      result.upTo = op.seq;
      if (op.member_id === cfg.memberId || op.device_id === cfg.deviceId) {
        result.skippedOwn++;
        continue;
      }
      const payload = Buffer.from(op.payload, "base64");
      let wire: WireFact;
      try {
        if (op.key_gen == null) {
          // v1-era op: raw TK_1, v1 AAD.
          wire = decryptOpV1(cfg.gens["1"], cfg.teamId, op.op_id, payload);
        } else {
          const tk = cfg.gens[String(op.key_gen)];
          if (!tk) {
            console.error(`[team] no key for gen ${op.key_gen} (op ${op.op_id}) — skipped`);
            continue;
          }
          const authorPub = (memberPub.get(op.member_id) as any)?.sign_pub;
          if (
            !authorPub ||
            !verifyPayload(authorPub, opSigPayload(cfg.teamId, op.op_id, op.key_gen, payload), op.op_sig ?? "")
          ) {
            console.error(`[team] op ${op.op_id}: attribution signature failed — skipped`);
            continue;
          }
          wire = decryptOpV2(tk, cfg.teamId, op.op_id, op.key_gen, op.member_id, payload);
        }
      } catch {
        console.error(`[team] cannot decrypt op ${op.op_id} — wrong key or tampering; skipped`);
        continue;
      }
      if (op.kind === "fact_label") {
        // LWW per (fact, member) on timestamp; teammate labels feed the
        // bounded curation boost at recall time.
        const l = wire as any;
        db.prepare(
          `INSERT INTO fact_labels (fact_id, member_id, verdict, ts, version, synced_version)
           VALUES (?, ?, ?, ?, 1, 1)
           ON CONFLICT(fact_id, member_id) DO UPDATE SET
             verdict = excluded.verdict, ts = excluded.ts
           WHERE excluded.ts > fact_labels.ts`,
        ).run(l.factId, op.member_id, l.verdict, l.ts);
        result.applied++;
        continue;
      }
      const applied = await applyRemoteFact({ deviceId: cfg.deviceId } as any, wire, op.kind, op.member_id ?? null);
      if (applied === "applied") result.applied++;
      if (applied === "conflict") {
        result.applied++;
        result.conflicts++;
      }
    }
  }
  db.prepare(`UPDATE sync_state SET last_seq = ?, last_sync = ? WHERE team_id = ?`).run(
    result.upTo,
    new Date().toISOString(),
    cfg.teamId,
  );
  return result;
}

/* ---------- v1 → v2 upgrade ---------- */

export async function upgradeFromV1(v1cfg: {
  serverUrl: string;
  teamId: string;
  token: string;
  key: string;
  deviceId: string;
}, displayName: string): Promise<TeamConfigV2> {
  const admin = generateMemberKeys();
  const cfg: TeamConfigV2 = {
    v: 2,
    serverUrl: v1cfg.serverUrl,
    teamId: v1cfg.teamId,
    deviceId: v1cfg.deviceId, // keep — op idempotence and skippedOwn survive
    memberId: admin.memberId,
    name: displayName,
    signPriv: admin.signPriv,
    signPub: admin.signPub,
    boxPriv: admin.boxPriv,
    boxPub: admin.boxPub,
    adminSignPub: admin.signPub,
    isAdmin: true,
    adminSignPriv: admin.signPriv,
    issuedInvites: {},
    gens: { "1": v1cfg.key }, // the old shared key becomes TK_1 — history stays readable
    currentGen: 1,
    recordsHead: { seq: 0, hash: GENESIS_PREV },
  };

  const genesis = signRecord(
    cfg.teamId,
    {
      seq: 1,
      kind: "genesis",
      body: {
        adminPub: admin.signPub,
        adminMemberId: admin.memberId,
        gen: 1,
        nameEnc: sealName(cfg, 1, admin.memberId, displayName),
        upgradedFromV1: true,
      },
      prevHash: GENESIS_PREV,
    },
    admin.signPriv,
  );
  const box = sealLockbox(cfg.teamId, 1, admin.memberId, admin.boxPub, v1cfg.key);
  const boxSig = signPayload(admin.signPriv, lockboxSigPayload(cfg.teamId, 1, admin.memberId, box));

  const res = await fetch(`${cfg.serverUrl.replace(/\/$/, "")}/v1/${cfg.teamId}/upgrade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${v1cfg.token}` },
    body: JSON.stringify({
      adminSignPub: admin.signPub,
      adminMember: {
        signPub: admin.signPub,
        boxPub: admin.boxPub,
        bindSig: makeBindSig(cfg.teamId, admin.boxPub, admin.signPriv),
        nameBox: null,
      },
      genesisRecord: genesis,
      lockbox: { box, boxSig },
    }),
  });
  if (!res.ok) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);

  cfg.recordsHead = { seq: 1, hash: recordHash(cfg.teamId, genesis) };
  getDb()
    .prepare(
      `INSERT INTO team_members (member_id, name, sign_pub, role, status) VALUES (?, ?, ?, 'admin', 'active')
       ON CONFLICT(member_id) DO UPDATE SET name = excluded.name`,
    )
    .run(admin.memberId, displayName, admin.signPub);
  save(cfg);
  // TK_1 traveled in v1 invites — rotate immediately so new content is fresh.
  await rotateTeam(cfg);
  return cfg;
}

export function syncStatusV2(cfg: TeamConfigV2): {
  members: { member_id: string; name: string | null; role: string; status: string }[];
  recordsHead: { seq: number; hash: string };
  currentGen: number;
} {
  const members = getDb()
    .prepare(`SELECT member_id, name, role, status FROM team_members ORDER BY role DESC, name`)
    .all() as any[];
  return { members, recordsHead: cfg.recordsHead, currentGen: cfg.currentGen };
}

export { syncConfigPath };

/* ---------- unified entry for the daemon heartbeat + `sync now` ---------- */

export async function syncNow(): Promise<{ push: PushResult; pull: PullResult; approved?: number } | null> {
  const { loadSyncConfig, push: pushV1, pull: pullV1 } = await import("./sync.js");
  const cfg = loadSyncConfig() as any;
  if (!cfg) return null;
  if (isV2(cfg)) {
    const state = await refreshTeamState(cfg);
    if (state.status === "pending") {
      return { push: { sent: 0, deduped: 0, blocked: [] }, pull: { applied: 0, conflicts: 0, skippedOwn: 0, upTo: 0 } };
    }
    const approved = cfg.isAdmin ? await drainPending(cfg) : 0;
    const push = await pushV2(cfg);
    const pull = await pullV2(cfg);
    return { push, pull, approved };
  }
  const push = await pushV1(cfg);
  const pull = await pullV1(cfg);
  return { push, pull };
}
