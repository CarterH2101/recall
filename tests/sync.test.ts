import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  encryptOp,
  decryptOp,
  encodeInvite,
  decodeInvite,
  remoteWins,
  gateContent,
  neutralizePaths,
  opId,
} from "../src/lib/sync.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

test("encrypt/decrypt round-trips and authenticates op identity", () => {
  const obj = { factId: "f1", content: "we chose BRIN indexes", version: 3 };
  const blob = encryptOp(KEY, "team-1", "op-1", obj);
  assert.deepEqual(decryptOp(KEY, "team-1", "op-1", blob), obj);

  // Wrong AAD (op id swapped) must fail — prevents replay under another id.
  assert.throws(() => decryptOp(KEY, "team-1", "op-2", blob));
  // Tampered ciphertext must fail.
  const tampered = Buffer.from(blob);
  tampered[14] ^= 0xff;
  assert.throws(() => decryptOp(KEY, "team-1", "op-1", tampered));
  // Wrong key must fail.
  assert.throws(() => decryptOp(Buffer.alloc(32, 9).toString("base64"), "team-1", "op-1", blob));
});

test("invite codes round-trip", () => {
  const cfg = { serverUrl: "https://sync.example.com", teamId: "t-1", token: "tok", key: KEY };
  assert.deepEqual(decodeInvite(encodeInvite(cfg)), cfg);
  assert.throws(() => decodeInvite("not-an-invite"));
});

test("LWW ordering: version, then timestamp, then device", () => {
  const base = { version: 2, updatedAt: "2026-08-11T10:00:00Z", device: "aaa" };
  assert.ok(remoteWins(base, { ...base, version: 3 }));
  assert.ok(!remoteWins(base, { ...base, version: 1 }));
  assert.ok(remoteWins(base, { ...base, updatedAt: "2026-08-11T11:00:00Z" }));
  assert.ok(remoteWins(base, { ...base, device: "bbb" }));
  assert.ok(!remoteWins(base, { ...base })); // exact tie: local wins (no churn)
});

test("redaction gate blocks secrets unless overridden", () => {
  const secret = `deploy key is ${"AKIA"}IOSFODNN7EXAMPLE ok`;
  const blocked = gateContent(secret, false);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.spans, ["aws-access-key"]);
  assert.equal(gateContent(secret, true).ok, true);
  assert.equal(gateContent("the daemon listens on 4319", false).ok, true);
});

test("home paths are neutralized before leaving the machine", () => {
  const home = os.homedir();
  const out = neutralizePaths(`db lives at ${home}\\.recall\\memory.db and ${home.replace(/\\/g, "/")}/x`);
  assert.ok(!out.includes(home));
  assert.ok(out.includes("~"));
});

test("op ids are deterministic per (device, fact, version)", () => {
  assert.equal(opId("d1", "f1", 3), opId("d1", "f1", 3));
  assert.notEqual(opId("d1", "f1", 3), opId("d1", "f1", 4));
});
