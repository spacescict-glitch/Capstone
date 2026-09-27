// ============================================================
// FILE: src/utils/academicTerm.js
// Academic term helper — used to generate & validate term-scoped
// QR codes. QR codes expire at the end of each term (semester).
//
// Philippine academic calendar convention:
//   - 1st Semester: August  – December   → "1S-YYYY-YYYY+1"
//   - 2nd Semester: January – May        → "2S-YYYY-1-YYYY"
//   - Summer/Midyear: June  – July       → "SU-YYYY-1-YYYY"
// ============================================================

/**
 * Returns the ID of the current academic term based on the given date.
 * @param {Date} date
 * @returns {string} e.g. "1S-2025-2026"
 */
export const getCurrentTerm = (date = new Date()) => {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();

  if (month >= 8 && month <= 12) return `1S-${year}-${year + 1}`; // Aug–Dec
  if (month >= 1 && month <= 5)  return `2S-${year - 1}-${year}`; // Jan–May
  return `SU-${year - 1}-${year}`; // Jun–Jul (Summer)
};

/**
 * Converts a term ID into a human-readable label.
 *   "1S-2025-2026" → "1st Semester 2025-2026"
 *   "2S-2025-2026" → "2nd Semester 2025-2026"
 *   "SU-2025-2026" → "Summer 2025-2026"
 */
export const getTermLabel = (termId) => {
  if (!termId) return "";
  const [code, start, end] = termId.split("-");
  switch (code) {
    case "1S": return `1st Semester ${start}-${end}`;
    case "2S": return `2nd Semester ${start}-${end}`;
    case "SU": return `Summer ${start}-${end}`;
    default:   return termId;
  }
};

/** Compact label for badges — "1S-2025-2026" → "1st Sem" */
export const getTermShortLabel = (termId) => {
  if (!termId) return "";
  const code = termId.split("-")[0];
  switch (code) {
    case "1S": return "1st Sem";
    case "2S": return "2nd Sem";
    case "SU": return "Summer";
    default:   return termId;
  }
};

/** Check whether a term ID matches the currently active term. */
export const isValidTerm = (termId) => {
  if (!termId) return false;
  return termId === getCurrentTerm();
};