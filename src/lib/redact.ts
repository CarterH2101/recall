import { loadConfig } from "./config.js";

// Secret redaction, applied at ingest before storage and embedding — secrets
// never reach turns.content or vec_turns. High-precision by design: rules
// anchor on distinctive vendor prefixes so false positives on code-heavy chat
// text stay near zero. This is a strong filter, not a guarantee; the generic
// rule is deliberately conservative because every false positive costs recall
// quality. (Rule shapes reference the gitleaks rule set, reimplemented.)

export interface RedactionResult {
  text: string;
  count: number;
  byRule: Record<string, number>;
}

interface Rule {
  id: string;
  pattern: RegExp;
  /** Redact only this capture group (1-based); whole match otherwise. */
  group?: number;
  /** Extra validation before redacting (entropy gates etc.). */
  validate?: (match: string) => boolean;
}

/** Shannon entropy in bits/char. */
export function entropy(s: string): number {
  if (!s.length) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER =
  /^(x+|\*+|\.+|your[-_]?|my[-_]?|example|changeme|placeholder|redacted|dummy|test|abc|foo|bar|<.*>|\$\{.*\}|\$[A-Z_]+|%[A-Z_]+%|process\.env)/i;
const ALL_HEX_40 = /^[0-9a-f]{40}$/i; // git sha
const ALL_HEX_64 = /^[0-9a-f]{64}$/i; // sha256 / lockfile hash
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_LIKE = /^(\.{0,2}[\\/]|[A-Za-z]:[\\/]|~[\\/])/;
const WORDS_ONLY = /^[a-z]+([-_ ][a-z]+)*$/;

function genericValueOk(v: string): boolean {
  if (PLACEHOLDER.test(v)) return false;
  if (ALL_HEX_40.test(v) || ALL_HEX_64.test(v) || UUID.test(v)) return false;
  if (PATH_LIKE.test(v) || WORDS_ONLY.test(v)) return false;
  return entropy(v) > 3.8;
}

// Order matters: multiline PEM blocks first (so JWT/generic don't chew
// fragments), distinctive prefixes next, the entropy-gated generic rule last.
const RULES: Rule[] = [
  {
    id: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----/g,
  },
  { id: "aws-access-key", pattern: /\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    id: "aws-secret-key",
    pattern: /(?:aws|amazon)[\w\s]{0,20}?(?:secret|sk)[\w\s]{0,20}?['"]([0-9A-Za-z/+=]{40})['"]/gi,
    group: 1,
  },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,255}\b/g },
  { id: "github-pat", pattern: /\bgithub_pat_[0-9A-Za-z_]{22,255}\b/g },
  {
    id: "openai-key",
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{10,}T3BlbkFJ[A-Za-z0-9_-]{10,}\b/g,
  },
  { id: "openai-key-legacy", pattern: /\bsk-[A-Za-z0-9]{48}\b/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { id: "slack-app-token", pattern: /\bxapp-1-[A-Z0-9]+-\d+-[a-f0-9]+\b/g },
  { id: "stripe-key", pattern: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: "twilio-key", pattern: /\bSK[a-f0-9]{32}\b/g },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{34}\b/g },
  { id: "gitlab-pat", pattern: /\bglpat-[0-9A-Za-z_-]{20,}\b/g },
  { id: "vercel-token", pattern: /\bvercel_[A-Za-z0-9]{24,}\b/g },
  { id: "netlify-token", pattern: /\bnfp_[A-Za-z0-9]{30,}\b/g },
  { id: "tailscale-key", pattern: /\btskey-[a-z]+-[A-Za-z0-9-]{10,}\b/g },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: "connection-string",
    // Password capture is greedy up to the LAST @ — real passwords contain @.
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s:@'"]{1,64}:([^\s'"]{4,})@/g,
    group: 1,
  },
  {
    id: "generic-assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|passwd|password|credential)s?\b.{0,8}?[:=].{0,6}?['"]([A-Za-z0-9+/_=\-]{20,})['"]/gi,
    group: 1,
    validate: genericValueOk,
  },
];

function applyRule(text: string, rule: Rule, byRule: Record<string, number>): string {
  return text.replace(rule.pattern, (whole: string, ...rest: any[]) => {
    const groups = rest.slice(0, -2); // trailing args are offset + full string
    const target = rule.group ? String(groups[rule.group - 1] ?? "") : whole;
    if (!target) return whole;
    if (rule.validate && !rule.validate(target)) return whole;
    byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
    const replacement = `[REDACTED:${rule.id}]`;
    return rule.group ? whole.replace(target, replacement) : replacement;
  });
}

export function redact(text: string): RedactionResult {
  const cfg = loadConfig().redaction;
  if (!cfg.enabled || !text) return { text, count: 0, byRule: {} };
  const byRule: Record<string, number> = {};
  let out = text;
  for (const rule of RULES) out = applyRule(out, rule, byRule);
  for (const custom of cfg.customPatterns) {
    out = applyRule(out, { id: custom.id, pattern: custom.pattern }, byRule);
  }
  const count = Object.values(byRule).reduce((a, b) => a + b, 0);
  return { text: out, count, byRule };
}

/** Merge per-rule counters (ingest aggregates across turns/files). */
export function mergeCounts(
  into: Record<string, number>,
  from: Record<string, number>,
): Record<string, number> {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  return into;
}
