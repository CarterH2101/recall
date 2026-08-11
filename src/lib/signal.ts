// Heuristics separating substantive turns from conversational narration, and
// detecting recall-about-recall content. Shared by ingest (embed gate),
// recall (self-match penalty), and the prune-noise maintenance CLI.

// Assistant narration openers: process chatter that carries no standalone
// information ("Perfect! Now let me...", "Updated", "Let me check...").
const NARRATION_START =
  /^(perfect|great|good|done|fixed|updated|sure|ok(ay)?|yes[.,!\s]|now let me|let me|i'?ll|i will|i'?m going to|first,? i|next,? i)\b/i;

/**
 * True when a turn is too thin to be worth recalling on its own. Low-signal
 * turns are still stored (they provide context expansion for neighbors) but
 * are not embedded, so they can never surface as a match.
 */
export function isLowSignal(role: string, content: string): boolean {
  const text = content.trim();
  if (role === "user") {
    // Short imperatives ("Run all these", "do the full run") match everything
    // and mean nothing outside their session.
    return text.length < 25;
  }
  if (text.length < 100) return true;
  if (text.length < 300 && NARRATION_START.test(text)) return true;
  return false;
}

const SELF_MARKERS =
  /auto-recalled|userpromptsubmit|prompt-hook|stop-hook|recalld|recall-mcp|recall daemon|recall store|recall hook/i;

/** True when a turn's content is about the recall system itself. */
export function isSelfReferential(text: string): boolean {
  if (SELF_MARKERS.test(text)) return true;
  return (text.match(/\brecall\b/gi) || []).length >= 3;
}

/** True when the query legitimately asks about recall/memory, so self-referential matches are fair game. */
export function queryMentionsRecall(query: string): boolean {
  return /recall|memor(y|ies)|past session|userpromptsubmit|hook/i.test(query);
}
