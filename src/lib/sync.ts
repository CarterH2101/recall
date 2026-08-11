import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getDb, vecBlob } from "./db.js";
import { redact } from "./redact.js";
import { contentHash, type Fact } from "./facts.js";
import { embedOne } from "./embed.js";

// Team sync client. Design notes:
// - True E2E: facts are AES-256-GCM encrypted with a shared team key before
//   leaving the machine; the hub stores opaque blobs and assigns sequence
//   numbers. Pulled facts are re-embedded LOCALLY — vectors never travel.
// - No outbox table: push diffs `shared` facts whose version > synced_version,
//   with DETERMINISTIC op ids (device:fact:version), so a crashed or retried
//   push is idempotent by construction.
// - Redaction is a hard gate at encrypt time. A hit blocks the fact unless it
//   was shared with --allow-secret (shared = 2).

export interface SyncConfig {
  serverUrl: string;
  teamId: string;
  token: string;
  key: string; // base64, 32 bytes
  deviceId: string;
}

export function syncConfigPath(): string {
  return path.join(os.homedir(), ".recall", "sync.json");
}

export function loadSyncConfig(): SyncConfig | null {
  try {
    return JSON.parse(fs.readFileSync(syncConfigPath(), "utf8"));
  } catch {
    return null;
  }
}

export function saveSyncConfig(cfg: SyncConfig): void {
  fs.mkdirSync(path.dirname(syncConfigPath()), { recursive: true });
  fs.writeFileSync(syncConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/* ---------- invites ---------- */

export function encodeInvite(cfg: Omit<SyncConfig, "deviceId">): string {
  return Buffer.from(
    JSON.stringify({ u: cfg.serverUrl, t: cfg.teamId, k: cfg.token, K: cfg.key }),
  ).toString("base64url");
}

export function decodeInvite(invite: string): Omit<SyncConfig, "deviceId"> {
  const o = JSON.parse(Buffer.from(invite.trim(), "base64url").toString("utf8"));
  if (!o.u || !o.t || !o.k || !o.K) throw new Error("malformed invite");
  return { serverUrl: o.u, teamId: o.t, token: o.k, key: o.K };
}

/* ---------- crypto ---------- */

export function encryptOp(keyB64: string, teamId: string, opId: string, obj: unknown): Buffer {
  const key = Buffer.from(keyB64, "base64");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${teamId}|${opId}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function decryptOp(keyB64: string, teamId: string, opId: string, blob: Buffer): any {
  const key = Buffer.from(keyB64, "base64");
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(`${teamId}|${opId}`));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

/* ---------- redaction gate ---------- */

export interface GateResult {
  ok: boolean;
  spans: string[];
}

/** Home-dir paths are personal metadata — rewrite before anything leaves. */
export function neutralizePaths(content: string): string {
  const home = os.homedir();
  const variants = [home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")];
  let out = content;
  for (const v of variants) out = out.split(v).join("~");
  return out;
}

export function gateContent(content: string, allowSecret: boolean): GateResult {
  if (allowSecret) return { ok: true, spans: [] };
  const r = redact(content);
  if (r.count === 0) return { ok: true, spans: [] };
  return { ok: false, spans: Object.keys(r.byRule) };
}

/* ---------- LWW ---------- */

export interface VersionStamp {
  version: number;
  updatedAt: string;
  device: string;
}

/** Deterministic total order: version, then timestamp, then device id. */
export function remoteWins(local: VersionStamp, remote: VersionStamp): boolean {
  if (remote.version !== local.version) return remote.version > local.version;
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt;
  return remote.device > local.device;
}

/* ---------- push / pull ---------- */

interface WireFact {
  factId: string;
  factKind: string;
  content: string;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  version: number;
  device: string;
}

export function opId(device: string, factId: string, version: number): string {
  return `${device}:${factId}:${version}`;
}

async function api(cfg: SyncConfig, method: string, pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(`${cfg.serverUrl.replace(/\/$/, "")}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${method} ${pathname}: ${(err as any).error ?? res.status}`);
  }
  return res.json();
}

export interface PushResult {
  sent: number;
  deduped: number;
  blocked: { factId: string; spans: string[] }[];
}

export async function push(cfg: SyncConfig): Promise<PushResult> {
  const db = getDb();
  const pending = db
    .prepare(`SELECT * FROM facts WHERE shared > 0 AND version > synced_version`)
    .all() as (Fact & { shared: number; version: number; synced_version: number })[];

  const result: PushResult = { sent: 0, deduped: 0, blocked: [] };
  if (!pending.length) return result;

  const ops: any[] = [];
  const sendable: typeof pending = [];
  for (const f of pending) {
    const kind = f.archived ? "fact_archive" : "fact_put";
    const content = neutralizePaths(f.content);
    const gate = gateContent(content, f.shared === 2);
    if (!gate.ok) {
      result.blocked.push({ factId: f.id, spans: gate.spans });
      continue;
    }
    const id = opId(cfg.deviceId, f.id, f.version);
    const wire: WireFact = {
      factId: f.id,
      factKind: f.kind,
      content,
      project: f.project,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
      pinned: !!f.pinned,
      archived: !!f.archived,
      version: f.version,
      device: cfg.deviceId,
    };
    ops.push({
      op_id: id,
      device_id: cfg.deviceId,
      kind,
      payload: encryptOp(cfg.key, cfg.teamId, id, wire).toString("base64"),
    });
    sendable.push(f);
  }
  if (!ops.length) return result;

  const r = await api(cfg, "POST", `/v1/${cfg.teamId}/ops`, { ops });
  const mark = db.prepare(`UPDATE facts SET synced_version = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (let i = 0; i < sendable.length; i++) {
      mark.run(sendable[i].version, sendable[i].id);
      if (r.results[i]?.deduped) result.deduped++;
      else result.sent++;
    }
  });
  tx();
  return result;
}

export interface PullResult {
  applied: number;
  conflicts: number;
  skippedOwn: number;
  upTo: number;
}

export async function pull(cfg: SyncConfig): Promise<PullResult> {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sync_state (team_id, last_seq) VALUES (?, 0)`).run(cfg.teamId);
  const state = db.prepare(`SELECT last_seq FROM sync_state WHERE team_id = ?`).get(cfg.teamId) as any;

  const result: PullResult = { applied: 0, conflicts: 0, skippedOwn: 0, upTo: state.last_seq };
  for (;;) {
    const batch = await api(cfg, "GET", `/v1/${cfg.teamId}/ops?since=${result.upTo}&limit=500`);
    if (!batch.ops.length) break;
    for (const op of batch.ops) {
      result.upTo = op.seq;
      if (op.device_id === cfg.deviceId) {
        result.skippedOwn++;
        continue;
      }
      let wire: WireFact;
      try {
        wire = decryptOp(cfg.key, cfg.teamId, op.op_id, Buffer.from(op.payload, "base64"));
      } catch {
        console.error(`[sync] cannot decrypt op ${op.op_id} — wrong key or tampering; skipped`);
        continue;
      }
      const applied = await applyRemoteFact(cfg, wire, op.kind);
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

async function applyRemoteFact(
  cfg: SyncConfig,
  wire: WireFact,
  opKind: string,
): Promise<"applied" | "conflict" | "stale"> {
  const db = getDb();
  const local = db.prepare(`SELECT rowid, * FROM facts WHERE id = ?`).get(wire.factId) as
    | (Fact & { rowid: number; version: number; synced_version: number; origin_device: string | null })
    | undefined;

  const archived = opKind === "fact_archive" || opKind === "fact_delete" || wire.archived;

  if (local) {
    const localStamp: VersionStamp = {
      version: local.version,
      updatedAt: local.updated_at,
      device: local.origin_device ?? cfg.deviceId,
    };
    const remoteStamp: VersionStamp = {
      version: wire.version,
      updatedAt: wire.updatedAt,
      device: wire.device,
    };
    if (!remoteWins(localStamp, remoteStamp)) return "stale";

    // Local has unsynced edits that are about to be overwritten: keep them as
    // a visible conflict copy rather than silently dropping work.
    let conflict = false;
    if (local.version > local.synced_version && local.content !== wire.content) {
      conflict = true;
      const copyContent = `[conflict] ${local.content}`.slice(0, 500);
      const info = db
        .prepare(
          `INSERT INTO facts (id, kind, content, content_hash, source_turn_ids, project, created_at, updated_at, pinned, archived, edited, origin, shared, version, synced_version, origin_device)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 'manual', 0, 0, -1, ?)`,
        )
        .run(
          `${wire.factId}-conflict-${Date.now()}`,
          local.kind,
          copyContent,
          contentHash(copyContent + String(Date.now())),
          local.source_turn_ids,
          local.project,
          local.created_at,
          new Date().toISOString(),
          cfg.deviceId,
        );
      const vec = await embedOne(copyContent.slice(0, 1500));
      db.prepare(`INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)`).run(
        BigInt(info.lastInsertRowid),
        vecBlob(vec),
      );
    }

    db.prepare(
      `UPDATE facts SET kind = ?, content = ?, content_hash = ?, project = ?, updated_at = ?,
        pinned = ?, archived = ?, edited = 0, origin = 'sync', shared = MAX(shared, 1),
        version = ?, synced_version = ?, origin_device = ? WHERE id = ?`,
    ).run(
      wire.factKind,
      wire.content,
      contentHash(wire.content),
      wire.project,
      wire.updatedAt,
      wire.pinned ? 1 : 0,
      archived ? 1 : 0,
      wire.version,
      wire.version,
      wire.device,
      wire.factId,
    );
    db.prepare(`DELETE FROM vec_facts WHERE rowid = ?`).run(BigInt(local.rowid));
    if (!archived) {
      const vec = await embedOne(wire.content.slice(0, 1500));
      db.prepare(`INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)`).run(
        BigInt(local.rowid),
        vecBlob(vec),
      );
    }
    return conflict ? "conflict" : "applied";
  }

  // New fact from a teammate — keep the team-global id.
  const info = db
    .prepare(
      `INSERT INTO facts (id, kind, content, content_hash, source_turn_ids, project, created_at, updated_at, pinned, archived, edited, origin, shared, version, synced_version, origin_device)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 0, 'sync', 1, ?, ?, ?)`,
    )
    .run(
      wire.factId,
      wire.factKind,
      wire.content,
      contentHash(wire.content),
      wire.project,
      wire.createdAt,
      wire.updatedAt,
      wire.pinned ? 1 : 0,
      archived ? 1 : 0,
      wire.version,
      wire.version,
      wire.device,
    );
  if (!archived) {
    const vec = await embedOne(wire.content.slice(0, 1500));
    db.prepare(`INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)`).run(
      BigInt(info.lastInsertRowid),
      vecBlob(vec),
    );
  }
  return "applied";
}
