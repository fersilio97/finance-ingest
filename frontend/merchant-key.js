/**
 * Shared merchant-key algorithm — spec 002 §A, verbatim.
 *
 * This is the ONE place this normalisation lives. It is imported by both the
 * review-queue grouping (002) and the over-broad-match conflict warning
 * (001 §C.2) so the two features can never disagree about what a "merchant"
 * is. Pure string in, string out — no other dependencies, nothing DOM- or
 * fetch-related belongs in this file.
 *
 * Algorithm (002 §A):
 *   1. Lowercase the description.
 *   2. Replace every character that is not a-z or a space with a space.
 *   3. Split on whitespace, drop any token of 2 characters or fewer.
 *   4. Take the first two remaining tokens, joined by a space.
 *
 * Known, documented heuristic failures (see 002 §A) — do not "fix" without
 * re-measuring against the acceptance numbers in that doc:
 *   - "No Description" -> "description" (the leading "no" is a 2-char token).
 *   - Multi-word Zelle flows split into several distinct keys.
 *   - A store number glued to a city name can split one merchant two ways.
 */
export function merchantKey(description) {
  const lower = (description || "").toLowerCase();
  const cleaned = lower.replace(/[^a-z ]/g, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 2);
  return tokens.slice(0, 2).join(" ");
}
