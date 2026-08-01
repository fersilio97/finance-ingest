/**
 * Shared merchant-key algorithm — spec 002 §A, verbatim.
 *
 * This is the ONE place this normalisation lives. It is imported by both the
 * review-queue grouping (002) and the over-broad-match conflict warning
 * (001 §C.2) so the two features can never disagree about what a "merchant"
 * is. Pure string in, string out — no other dependencies, nothing DOM- or
 * fetch-related belongs in this file.
 *
 * Algorithm (002 §A, revised 2026-08 to fix the IN-N-OUT case below):
 *   1. Lowercase the description.
 *   2. Replace every character that is not a-z or a space with a space.
 *   3. Split on whitespace into raw tokens.
 *   4. Look at the *leading* run of consecutive short tokens (length <= 2)
 *      at the very start of the token list:
 *        - a run of 2 or more collapses into a single merged anchor unit
 *          (the short tokens joined by a space) that is kept, however short
 *          it is;
 *        - a run of exactly 1 (an isolated leading short token with no
 *          short neighbour) is dropped, exactly as before.
 *      Everywhere else in the description, a short token is still dropped
 *      on its own — this step only changes what happens at the front.
 *   5. Take the first two remaining tokens/units, joined by a space. That is
 *      the key.
 *
 * Why leading-only: a run of short tokens right at the start of a
 * description is almost always a hyphen- or space-separated proper name
 * spelled in short fragments — "IN-N-OUT" tokenises to "in", "n", "out",
 * and the old length-only filter dropped "in" and "n" and let the
 * incidental next city word stand in as the second anchor token instead of
 * "out". Merging the leading run into one anchor fixes that. Restricting
 * the merge to the leading position (rather than merging *any* run of short
 * tokens wherever it occurs) was a deliberate choice: a mid-description
 * short-token run (e.g. "SMITH'S F 8525 PURCHASE...", tokens ...,"s","f",
 * "purchase",...) would otherwise get pulled into the anchor position ahead
 * of a perfectly good long token ("purchase"), trading one heuristic
 * failure for a less-readable one. Measured (see 002 §A) — leading-only
 * reproduces the exact pre-existing key for every case that isn't the
 * leading-short-run pattern, so it carries no other behaviour change.
 *
 * Fixed case — IN-N-OUT (was: 6 live rows -> 6 different keys):
 *   "IN-N-OUT LV - RAINBOW 02/08 PURCHASE LAS VEGAS NV"      -> "in n out"
 *   "IN-N-OUT LAS VEGAS 05/02 PURCHASE LAS VEGAS NV"          -> "in n out"
 *   "IN-N-OUT GLENDORA GLENDORA CA"                           -> "in n out"
 *   "IN-N-OUT LV - SAHARA LAS VEGAS NV"                       -> "in n out"
 *   "IN-N-OUT BAKERSFIELD BAKERSFIELD CA"                     -> "in n out"
 *   "IN-N-OUTWASHINGTONCITY WASHINGTON CIUT"                  -> "in n outwashingtoncity"
 *   Five of the six now share one key. The sixth has no space or hyphen
 *   between "OUT" and "WASHINGTONCITY" in the source description itself (a
 *   separate, pre-existing data-glue defect, not a short-token problem) —
 *   see 002 §A for the measured before/after and why this residual is
 *   expected, not a regression.
 *
 * Known, still-open heuristic failures (see 002 §A) — do not "fix" without
 * re-measuring against the acceptance numbers in that doc:
 *   - "No Description" -> "description" (the leading "no" is an isolated
 *     leading short token with no short neighbour, so it is still dropped —
 *     byte-identical to the old behaviour, still harmless).
 *   - Multi-word Zelle flows split into several distinct keys.
 *   - "7-ELEVEN" keys to "eleven purchase" — the leading digit is stripped
 *     entirely by step 2 (it never becomes a token at all), so it never
 *     reaches the leading-run logic. Unaffected by this change.
 *   - A store number glued to a city name (e.g. `SMITH'S FOOD & DRUG
 *     #4315LAS VEGAS NV`) can still split one merchant multiple ways —
 *     unaffected, since the short tokens there aren't at the leading edge.
 */
export function merchantKey(description) {
  const lower = (description || "").toLowerCase();
  const cleaned = lower.replace(/[^a-z ]/g, " ");
  const rawTokens = cleaned.split(/\s+/).filter((t) => t.length > 0);

  let leadRunEnd = 0;
  while (leadRunEnd < rawTokens.length && rawTokens[leadRunEnd].length <= 2) {
    leadRunEnd += 1;
  }

  let tokens;
  if (leadRunEnd >= 2) {
    // Two or more consecutive short tokens at the start: merge them into
    // one anchor unit instead of dropping them.
    const merged = rawTokens.slice(0, leadRunEnd).join(" ");
    tokens = [merged, ...rawTokens.slice(leadRunEnd).filter((t) => t.length > 2)];
  } else {
    // No leading run (or just one isolated short token, which is dropped
    // here along with every other short token) — identical to the
    // original algorithm.
    tokens = rawTokens.filter((t) => t.length > 2);
  }

  return tokens.slice(0, 2).join(" ");
}
