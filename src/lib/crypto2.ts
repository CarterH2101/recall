import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

// Team sync v2 cryptography. Composition of standard primitives only:
// Ed25519 (identity + signatures), X25519 ECDH + HKDF-SHA256 + AES-256-GCM
// (lockboxes and op encryption), SHA-256 (ids and the membership hash chain).
// Every key travels as base64 DER (pkcs8 for private, spki for public) so
// callers never juggle raw key bytes.
//
// Key hierarchy:
//   member: Ed25519 idSign (auth + attribution) + X25519 idBox (receives
//           lockboxes), bound by bindSig = sign(teamId|'bind'|boxPubDer)
//   team:   TK_1..TK_g, 32 random bytes per generation; rotation mints a new
//           generation — history is NEVER re-encrypted
//   derive: opKey_g = HKDF(TK_g, salt=teamId, info='recall-v2/op-key')

const OP_INFO = "recall-v2/op-key";
const META_INFO = "recall-v2/meta-key";
const LOCKBOX_INFO = "recall-v2/lockbox";
const NAME_INFO = "recall-v2/join-name";

export interface MemberKeys {
  memberId: string;
  signPriv: string; // base64 pkcs8 DER
  signPub: string; // base64 spki DER
  boxPriv: string;
  boxPub: string;
}

const b64 = (b: Buffer) => b.toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

function privKey(der: string): KeyObject {
  return createPrivateKey({ key: unb64(der), format: "der", type: "pkcs8" });
}
function pubKey(der: string): KeyObject {
  return createPublicKey({ key: unb64(der), format: "der", type: "spki" });
}

export function memberIdFromSignPub(signPubDer: string): string {
  return sha256(unb64(signPubDer)).toString("base64url").slice(0, 22);
}

export function generateMemberKeys(): MemberKeys {
  const s = generateKeyPairSync("ed25519");
  const x = generateKeyPairSync("x25519");
  const signPub = b64(s.publicKey.export({ format: "der", type: "spki" }) as Buffer);
  return {
    memberId: memberIdFromSignPub(signPub),
    signPriv: b64(s.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer),
    signPub,
    boxPriv: b64(x.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer),
    boxPub: b64(x.publicKey.export({ format: "der", type: "spki" }) as Buffer),
  };
}

export function generateAdminSignKeys(): { signPriv: string; signPub: string } {
  const s = generateKeyPairSync("ed25519");
  return {
    signPriv: b64(s.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer),
    signPub: b64(s.publicKey.export({ format: "der", type: "spki" }) as Buffer),
  };
}

/* ---------- binding the two member keys ---------- */

export function makeBindSig(teamId: string, boxPubDer: string, signPrivDer: string): string {
  return b64(edSign(null, Buffer.concat([Buffer.from(`${teamId}|bind|`), unb64(boxPubDer)]), privKey(signPrivDer)));
}

export function verifyBindSig(
  teamId: string,
  boxPubDer: string,
  signPubDer: string,
  bindSig: string,
): boolean {
  try {
    return edVerify(
      null,
      Buffer.concat([Buffer.from(`${teamId}|bind|`), unb64(boxPubDer)]),
      pubKey(signPubDer),
      unb64(bindSig),
    );
  } catch {
    return false;
  }
}

/* ---------- team keys + derivations ---------- */

export function newTeamKey(): string {
  return b64(randomBytes(32));
}

export function deriveOpKey(tkB64: string, teamId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", unb64(tkB64), Buffer.from(teamId), Buffer.from(OP_INFO), 32));
}

/** Key for E2E metadata (member display names inside record bodies) — the
 *  record chain itself is server-visible, so names never appear in it raw. */
export function deriveMetaKey(tkB64: string, teamId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", unb64(tkB64), Buffer.from(teamId), Buffer.from(META_INFO), 32));
}

export function deriveNameKey(joinSecretB64url: string, teamId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(joinSecretB64url, "base64url"), Buffer.from(teamId), Buffer.from(NAME_INFO), 32),
  );
}

/* ---------- lockboxes: TK_g wrapped to a member's X25519 key ---------- */

export function sealLockbox(
  teamId: string,
  gen: number,
  memberId: string,
  recipientBoxPubDer: string,
  tkB64: string,
): string {
  const e = generateKeyPairSync("x25519");
  const ss = diffieHellman({ privateKey: e.privateKey, publicKey: pubKey(recipientBoxPubDer) });
  const wrapKey = Buffer.from(
    hkdfSync("sha256", ss, Buffer.from(teamId), Buffer.from(`${LOCKBOX_INFO}|g${gen}|${memberId}`), 32),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
  cipher.setAAD(Buffer.from(`${teamId}|lockbox|g${gen}|${memberId}`));
  const ct = Buffer.concat([cipher.update(unb64(tkB64)), cipher.final()]);
  // ephemeral pub as raw 32 bytes (strip the 12-byte spki x25519 prefix)
  const ePubDer = e.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const ePubRaw = ePubDer.subarray(ePubDer.length - 32);
  return b64(Buffer.concat([ePubRaw, nonce, ct, cipher.getAuthTag()]));
}

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function openLockbox(
  teamId: string,
  gen: number,
  memberId: string,
  boxPrivDer: string,
  boxB64: string,
): string {
  const blob = unb64(boxB64);
  const ePubRaw = blob.subarray(0, 32);
  const nonce = blob.subarray(32, 44);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(44, blob.length - 16);
  const ePub = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, ePubRaw]),
    format: "der",
    type: "spki",
  });
  const ss = diffieHellman({ privateKey: privKey(boxPrivDer), publicKey: ePub });
  const wrapKey = Buffer.from(
    hkdfSync("sha256", ss, Buffer.from(teamId), Buffer.from(`${LOCKBOX_INFO}|g${gen}|${memberId}`), 32),
  );
  const d = createDecipheriv("aes-256-gcm", wrapKey, nonce);
  d.setAAD(Buffer.from(`${teamId}|lockbox|g${gen}|${memberId}`));
  d.setAuthTag(tag);
  return b64(Buffer.concat([d.update(ct), d.final()]));
}

export function lockboxSigPayload(teamId: string, gen: number, memberId: string, boxB64: string): Buffer {
  return sha256(Buffer.concat([Buffer.from(`${teamId}|lockbox|${gen}|${memberId}|`), unb64(boxB64)]));
}

/* ---------- generic Ed25519 helpers ---------- */

export function signPayload(signPrivDer: string, payload: Buffer): string {
  return b64(edSign(null, payload, privKey(signPrivDer)));
}

export function verifyPayload(signPubDer: string, payload: Buffer, sigB64: string): boolean {
  try {
    return edVerify(null, payload, pubKey(signPubDer), unb64(sigB64));
  } catch {
    return false;
  }
}

/* ---------- signed HTTP requests (replace bearer tokens) ---------- */

export function requestSigPayload(method: string, path: string, ts: string, body: string): Buffer {
  return sha256(Buffer.from(`${method.toUpperCase()}\n${path}\n${ts}\n${sha256(body).toString("hex")}`));
}

export function signRequest(
  signPrivDer: string,
  method: string,
  path: string,
  ts: string,
  body: string,
): string {
  return signPayload(signPrivDer, requestSigPayload(method, path, ts, body));
}

export function verifyRequest(
  signPubDer: string,
  method: string,
  path: string,
  ts: string,
  body: string,
  sigB64: string,
  windowMs = 5 * 60_000,
  now = Date.now(),
): boolean {
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > windowMs) return false;
  return verifyPayload(signPubDer, requestSigPayload(method, path, ts, body), sigB64);
}

/* ---------- op encryption v2 ---------- */

export function encryptOpV2(
  tkB64: string,
  teamId: string,
  opId: string,
  gen: number,
  memberId: string,
  obj: unknown,
): Buffer {
  const key = deriveOpKey(tkB64, teamId);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${teamId}|${opId}|g${gen}|${memberId}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function decryptOpV2(
  tkB64: string,
  teamId: string,
  opId: string,
  gen: number,
  memberId: string,
  blob: Buffer,
): any {
  const key = deriveOpKey(tkB64, teamId);
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(`${teamId}|${opId}|g${gen}|${memberId}`));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

/** Attribution signature over the ciphertext — honest authorship even against
 *  teammates who hold the same TK. */
export function opSigPayload(teamId: string, opId: string, gen: number, payload: Buffer): Buffer {
  return sha256(Buffer.from(`${teamId}|${opId}|g${gen}|${sha256(payload).toString("hex")}`));
}

/* ---------- membership record chain ---------- */

export interface TeamRecord {
  seq: number;
  kind: "genesis" | "member_add" | "member_revoke" | "rotate";
  body: any; // kind-specific; canonicalized via JSON.stringify of sorted keys
  prevHash: string; // hex; genesis uses 64 zeros
  sig: string; // admin Ed25519 over recordHash
}

export function canonicalBody(body: any): string {
  // Stable serialization: sort keys one level deep (bodies are flat objects).
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(body).sort()) sorted[k] = body[k];
  return JSON.stringify(sorted);
}

export function recordHash(teamId: string, r: Omit<TeamRecord, "sig">): string {
  return sha256(
    Buffer.from(`${teamId}|rec|${r.seq}|${r.kind}|${r.prevHash}|${canonicalBody(r.body)}`),
  ).toString("hex");
}

export function signRecord(teamId: string, r: Omit<TeamRecord, "sig">, adminSignPrivDer: string): TeamRecord {
  return { ...r, sig: signPayload(adminSignPrivDer, Buffer.from(recordHash(teamId, r), "hex")) };
}

export const GENESIS_PREV = "0".repeat(64);

/** Verify an ordered record chain against the pinned admin key. Returns the
 *  head {seq, hash} on success; throws on any break. */
export function verifyChain(
  teamId: string,
  records: TeamRecord[],
  adminSignPubDer: string,
  from?: { seq: number; hash: string },
): { seq: number; hash: string } {
  let prev = from ?? { seq: 0, hash: GENESIS_PREV };
  for (const r of records) {
    if (r.seq !== prev.seq + 1) throw new Error(`record chain gap at seq ${r.seq}`);
    if (r.prevHash !== prev.hash) throw new Error(`record chain fork at seq ${r.seq}`);
    const h = recordHash(teamId, r);
    if (!verifyPayload(adminSignPubDer, Buffer.from(h, "hex"), r.sig)) {
      throw new Error(`bad record signature at seq ${r.seq}`);
    }
    prev = { seq: r.seq, hash: h };
  }
  return prev;
}

/* ---------- small helpers ---------- */

export function aesGcmSeal(key: Buffer, aad: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

export function aesGcmOpen(key: Buffer, aad: string, blob: Buffer): Buffer {
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
