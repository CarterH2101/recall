import test from "node:test";
import assert from "node:assert/strict";
import { redact, entropy } from "../src/lib/redact.js";

// True-positive samples are constructed at runtime by concatenation so no
// scanner (GitHub push protection included) ever flags this file.

const A = "A".repeat(16);
const HEX32 = "abcdef0123456789abcdef0123456789";

const TRUE_POSITIVES: [string, string][] = [
  ["aws-access-key", "AKIA" + "IOSFODNN7EXAMPLE"],
  ["github-token", "ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"],
  ["github-pat", "github_pat_" + "11ABCDEFG0" + "abcdefghijklmnopqrstuv"],
  ["openai-key", "sk-proj-" + "abc123DEF456ghi789JK" + "T3BlbkFJ" + "lmn012OPQ345rst678UV"],
  ["anthropic-key", "sk-ant-" + "api03-abcDEF123456789012345"],
  ["slack-token", "xoxb-" + "123456789012-abcdefABCDEF"],
  ["stripe-key", "sk_live_" + "abcdefghijklmnopqrst1234"],
  ["google-api-key", "AIza" + "SyA1234567890abcdefghijklmnopqrstuv"],
  ["npm-token", "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789"],
  ["huggingface-token", "hf_" + "abcdefghijklmnopqrstuvwxyzABCDEFGH"],
  ["gitlab-pat", "glpat-" + "abcdefghij1234567890"],
  ["tailscale-key", "tskey-auth-" + "kAbCdEf1234567890"],
  ["twilio-key", "SK" + HEX32],
  [
    "jwt",
    "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dQw4w9WgXcQabc123DEF456",
  ],
];

for (const [rule, sample] of TRUE_POSITIVES) {
  test(`redacts ${rule}`, () => {
    const r = redact(`the key is ${sample} — do not share`);
    assert.equal(r.count, 1, `expected 1 redaction, got ${JSON.stringify(r.byRule)}`);
    assert.ok(r.text.includes(`[REDACTED:${rule}]`), `text: ${r.text}`);
    assert.ok(!r.text.includes(sample));
  });
}

test("redacts PEM block as a single unit", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${A}\nQID${A}\n-----END RSA PRIVATE KEY-----`;
  const r = redact(`config:\n${pem}\ndone`);
  assert.equal(r.count, 1);
  assert.ok(r.text.includes("[REDACTED:private-key-block]"));
  assert.ok(!r.text.includes("BEGIN RSA"));
});

test("redacts only the password in connection strings", () => {
  const r = redact("DATABASE_URL=postgres://admin:s3cretP@ssw0rd@db.example.com:5432/prod");
  assert.equal(r.count, 1);
  assert.ok(r.text.includes("postgres://admin:[REDACTED:connection-string]@db.example.com"));
});

test("generic assignment: catches high-entropy, keeps placeholders", () => {
  const secret = "q7Zp3RxKm9WvT2yBnL5cJfH8dGsA4eUx";
  const hit = redact(`api_key = "${secret}"`);
  assert.equal(hit.count, 1, JSON.stringify(hit.byRule));

  for (const fp of [
    `api_key = "your-api-key-goes-here-ok"`,
    `password: "changeme"`,
    `token = "xxxxxxxxxxxxxxxxxxxxxxxx"`,
    `secret: "${"a".repeat(24)}"`,
  ]) {
    assert.equal(redact(fp).count, 0, `false positive on: ${fp}`);
  }
});

test("zero false positives on ordinary code and hashes", () => {
  const samples = [
    "commit 3f786850e387550fdab836ed7e6dc881de23001b fixed the bug",
    "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "id: 0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001",
    "const apiKey = process.env.API_KEY;",
    "npm install @modelcontextprotocol/sdk better-sqlite3",
    "the function signature is embed(texts: string[]): Promise<Float32Array[]>",
    "path C:\\Users\\dev\\.recall\\memory.db",
    "Bearer token auth is required for non-localhost requests",
  ];
  for (const s of samples) {
    const r = redact(s);
    assert.equal(r.count, 0, `false positive on: ${s} -> ${JSON.stringify(r.byRule)}`);
  }
});

test("redaction is idempotent", () => {
  const once = redact(`key: ghp_${"z".repeat(36)}`);
  assert.equal(once.count, 1);
  const twice = redact(once.text);
  assert.equal(twice.count, 0);
  assert.equal(twice.text, once.text);
});

test("entropy helper behaves", () => {
  assert.ok(entropy("aaaaaaaa") < 1);
  assert.ok(entropy("q7Zp3RxKm9WvT2yBnL5c") > 3.8);
});
