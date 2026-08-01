/**
 * Rule-keyword helpers for spec 001 — suggestion, matching, and the pieces
 * the conflict-warning logic in app.js is built from. Pure functions over
 * strings/plain objects; no DOM, no fetch. `merchantKey` (the 002 grouping
 * key) is intentionally NOT duplicated here — app.js imports it separately
 * from merchant-key.js for the over-broad-match warning, per 001's own note
 * that the two features must share one implementation.
 */

// US state postal codes plus a handful of country/currency codes seen in the
// live data (ES, MX, GB) — used only to trim an obvious trailing
// "CITY STATE" location suffix, never to reject a keyword outright.
const LOCATION_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt",
  "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri",
  "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
  "es", "mx", "gb",
]);

// Recurring-billing boilerplate that identifies a *frequency*, not a
// merchant — dropping it (and everything after it) is what turns
// "CLASSPASS* MONTHLY 11/16 PURCHASE ..." into "classpass" instead of
// "classpass monthly".
const FREQUENCY_STOPWORDS = new Set([
  "monthly", "weekly", "annual", "annually", "yearly", "biweekly",
  "recurring", "autopay", "auto-pay",
]);

// Cut everything from a confirmation/reference marker onward — this is
// exactly the "confirmation code" the spec says a suggestion must never
// contain.
const CONFIRMATION_MARKER = /\b(confirmation\s*#?|conf\s*#|ref\s*#|reference\s*#|id\s*#)\b[\s\S]*$/i;

const MAX_SUGGESTION_WORDS = 5;

/**
 * Derive a suggested rule keyword from a transaction description — spec 001
 * §A. Always lowercase, never contains a digit, 1-5 words, and — per the
 * acceptance test — never byte-identical to the input. Returns "" when
 * nothing meaningful can be derived (e.g. "No Description"), which the
 * caller must render as an empty field with its placeholder, not fill with
 * junk.
 */
export function suggestKeyword(description) {
  const trimmed = (description || "").trim();
  if (!trimmed || trimmed.toLowerCase() === "no description") return "";

  // Work on the *original*-case string so we can tell bank boilerplate
  // (Title Case / lowercase, e.g. "Zelle payment from") apart from free text
  // a person typed (bank statements render that in ALL CAPS, e.g. a Zelle
  // memo name) — see the all-caps-run check below.
  const withoutConfirmation = trimmed.replace(CONFIRMATION_MARKER, "");
  const rawTokens = withoutConfirmation.split(/\s+/).filter(Boolean);
  const isShouty = !/[a-z]/.test(withoutConfirmation); // no lowercase anywhere = the whole description is shouting

  const kept = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const raw = rawTokens[i];
    if (/\d/.test(raw)) break; // digit, date, amount, or store number — hard stop
    const lower = raw.toLowerCase();
    const bare = lower.replace(/[^a-z]/g, "");
    if (FREQUENCY_STOPWORDS.has(bare)) break;
    // A trailing 2-letter location code only counts once we already have a
    // real word — otherwise a leading "LA" ("LA CENTRAL SANTANDER...") would
    // wrongly be treated as Louisiana and swallow the whole suggestion.
    if (kept.length > 0 && LOCATION_CODES.has(bare)) break;

    // Two-or-more consecutive ALL-CAPS tokens inside an otherwise
    // mixed-case description are free text a person typed — a Zelle memo
    // name, not merchant identity ("Zelle payment from JUAN HUGO..." ->
    // stop before JUAN). Only meaningful when the description isn't
    // shouting throughout (a card-purchase description in full caps would
    // otherwise trigger on every token).
    if (!isShouty && bare.length >= 2 && raw === raw.toUpperCase()) {
      const next = rawTokens[i + 1] || "";
      const nextBare = next.toLowerCase().replace(/[^a-z]/g, "");
      if (next && next === next.toUpperCase() && nextBare.length >= 2) break;
    }

    const tok = raw === "&" ? "&" : lower.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (tok) kept.push(tok);
    if (kept.length >= MAX_SUGGESTION_WORDS) break;
  }

  const suggestion = kept.join(" ").trim();
  if (!suggestion || suggestion === trimmed) return "";
  return suggestion;
}

/**
 * Same substring semantics as backend/app/rules/engine.py's `apply_rules`
 * (`rule.match_text.lower() in description.lower()`). If this ever
 * disagrees with the engine, the live preview is worse than useless.
 */
export function matchesKeyword(description, keyword) {
  if (!keyword) return false;
  return (description || "").toLowerCase().includes(keyword.toLowerCase());
}

/**
 * Whether two rule source scopes overlap, matching engine.py's
 * `WHERE source IS NULL OR source = ?`: "All sources" (null/"") overlaps
 * with everything.
 */
export function sourceScopesOverlap(a, b) {
  if (!a || !b) return true;
  return a === b;
}

/** Does `ruleSource` (a rule's scope) apply to a transaction from `txnSource`? */
export function ruleAppliesToSource(ruleSource, txnSource) {
  return !ruleSource || ruleSource === txnSource;
}
