import test from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS_PREV,
  decryptOpV2,
  deriveOpKey,
  encryptOpV2,
  generateAdminSignKeys,
  generateMemberKeys,
  lockboxSigPayload,
  makeBindSig,
  memberIdFromSignPub,
  newTeamKey,
  openLockbox,
  opSigPayload,
  recordHash,
  sealLockbox,
  signPayload,
  signRecord,
  signRequest,
  verifyBindSig,
  verifyChain,
  verifyPayload,
  verifyRequest,
  type TeamRecord,
} from "../src/lib/crypto2.js";

const TEAM = "team-0001";

test("member keys: deterministic self-certifying id + bind signature", () => {
  const m = generateMemberKeys();
  assert.equal(m.memberId, memberIdFromSignPub(m.signPub));
  assert.equal(m.memberId.length, 22);

  const bind = makeBindSig(TEAM, m.boxPub, m.signPriv);
  assert.ok(verifyBindSig(TEAM, m.boxPub, m.signPub, bind));
  // A different member cannot claim this box key.
  const impostor = generateMemberKeys();
  assert.ok(!verifyBindSig(TEAM, m.boxPub, impostor.signPub, bind));
  // Nor does the sig hold for a different team.
  assert.ok(!verifyBindSig("team-0002", m.boxPub, m.signPub, bind));
});

test("lockbox: seal/open round-trips; any context change breaks it", () => {
  const m = generateMemberKeys();
  const tk = newTeamKey();
  const box = sealLockbox(TEAM, 3, m.memberId, m.boxPub, tk);
  assert.equal(openLockbox(TEAM, 3, m.memberId, m.boxPriv, box), tk);

  // wrong recipient key
  const other = generateMemberKeys();
  assert.throws(() => openLockbox(TEAM, 3, m.memberId, other.boxPriv, box));
  // wrong generation (AAD + HKDF info both bind it)
  assert.throws(() => openLockbox(TEAM, 4, m.memberId, m.boxPriv, box));
  // wrong member id
  assert.throws(() => openLockbox(TEAM, 3, other.memberId, m.boxPriv, box));
  // tampered ciphertext
  const t = Buffer.from(box, "base64");
  t[50] ^= 0xff;
  assert.throws(() => openLockbox(TEAM, 3, m.memberId, m.boxPriv, t.toString("base64")));
});

test("lockbox admin signature pins the exact box to gen+member", () => {
  const admin = generateAdminSignKeys();
  const m = generateMemberKeys();
  const tk = newTeamKey();
  const box = sealLockbox(TEAM, 1, m.memberId, m.boxPub, tk);
  const sig = signPayload(admin.signPriv, lockboxSigPayload(TEAM, 1, m.memberId, box));
  assert.ok(verifyPayload(admin.signPub, lockboxSigPayload(TEAM, 1, m.memberId, box), sig));
  // A server substituting a different box (even a valid one) fails the sig.
  const evil = sealLockbox(TEAM, 1, m.memberId, m.boxPub, newTeamKey());
  assert.ok(!verifyPayload(admin.signPub, lockboxSigPayload(TEAM, 1, m.memberId, evil), sig));
});

test("op encryption v2: gen and author are bound into the ciphertext", () => {
  const tk = newTeamKey();
  const obj = { factId: "f1", content: "we chose BRIN", version: 2 };
  const blob = encryptOpV2(tk, TEAM, "op-1", 2, "member-a", obj);
  assert.deepEqual(decryptOpV2(tk, TEAM, "op-1", 2, "member-a", blob), obj);

  assert.throws(() => decryptOpV2(tk, TEAM, "op-1", 3, "member-a", blob)); // wrong gen
  assert.throws(() => decryptOpV2(tk, TEAM, "op-1", 2, "member-b", blob)); // forged author
  assert.throws(() => decryptOpV2(tk, TEAM, "op-2", 2, "member-a", blob)); // replayed under other id
  assert.throws(() => decryptOpV2(newTeamKey(), TEAM, "op-1", 2, "member-a", blob)); // wrong key
});

test("op attribution signature is member-specific", () => {
  const a = generateMemberKeys();
  const b = generateMemberKeys();
  const tk = newTeamKey();
  const blob = encryptOpV2(tk, TEAM, "op-9", 1, a.memberId, { x: 1 });
  const sig = signPayload(a.signPriv, opSigPayload(TEAM, "op-9", 1, blob));
  assert.ok(verifyPayload(a.signPub, opSigPayload(TEAM, "op-9", 1, blob), sig));
  assert.ok(!verifyPayload(b.signPub, opSigPayload(TEAM, "op-9", 1, blob), sig));
});

test("signed requests: fresh window verifies, stale/tampered rejected", () => {
  const m = generateMemberKeys();
  const ts = new Date().toISOString();
  const body = JSON.stringify({ ops: [] });
  const sig = signRequest(m.signPriv, "POST", "/v1/t/ops", ts, body);
  assert.ok(verifyRequest(m.signPub, "POST", "/v1/t/ops", ts, body, sig));
  assert.ok(!verifyRequest(m.signPub, "POST", "/v1/t/ops", ts, body + " ", sig)); // body swap
  assert.ok(!verifyRequest(m.signPub, "GET", "/v1/t/ops", ts, body, sig)); // method swap
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const staleSig = signRequest(m.signPriv, "POST", "/v1/t/ops", stale, body);
  assert.ok(!verifyRequest(m.signPub, "POST", "/v1/t/ops", stale, body, staleSig)); // replay window
});

test("record chain: verifies in order, rejects forks/gaps/forgeries", () => {
  const admin = generateAdminSignKeys();
  const notAdmin = generateAdminSignKeys();

  const r1: TeamRecord = signRecord(
    TEAM,
    { seq: 1, kind: "genesis", body: { adminPub: admin.signPub }, prevHash: GENESIS_PREV },
    admin.signPriv,
  );
  const r2: TeamRecord = signRecord(
    TEAM,
    { seq: 2, kind: "member_add", body: { memberId: "m1", name: "alice" }, prevHash: recordHash(TEAM, r1) },
    admin.signPriv,
  );
  const r3: TeamRecord = signRecord(
    TEAM,
    { seq: 3, kind: "rotate", body: { gen: 2 }, prevHash: recordHash(TEAM, r2) },
    admin.signPriv,
  );

  const head = verifyChain(TEAM, [r1, r2, r3], admin.signPub);
  assert.equal(head.seq, 3);

  // Incremental verification from a stored head (client resumes mid-chain).
  const mid = verifyChain(TEAM, [r1, r2], admin.signPub);
  assert.deepEqual(verifyChain(TEAM, [r3], admin.signPub, mid), head);

  // Forged signer.
  const forged = signRecord(
    TEAM,
    { seq: 4, kind: "member_revoke", body: { memberId: "m1" }, prevHash: head.hash },
    notAdmin.signPriv,
  );
  assert.throws(() => verifyChain(TEAM, [forged], admin.signPub, head), /bad record signature/);

  // Tampered body (sig no longer matches).
  const tampered = { ...r2, body: { memberId: "mALLORY", name: "alice" } };
  assert.throws(() => verifyChain(TEAM, [r1, tampered as TeamRecord, r3], admin.signPub), /bad record signature|fork/);

  // Gap (server withholding a record is detectable).
  assert.throws(() => verifyChain(TEAM, [r1, r3], admin.signPub), /gap|fork/);
});

test("opKey derivation is team-scoped", () => {
  const tk = newTeamKey();
  assert.notDeepEqual(deriveOpKey(tk, "team-a"), deriveOpKey(tk, "team-b"));
});
