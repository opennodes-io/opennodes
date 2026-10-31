// Region containment (ONP-2 §3): case-insensitive codes where a code contains its own
// subdivisions, so "CA" contains "CA-QC" and legacy "eu" contains "eu-central".

/** Is region `code` inside `required`? */
export function regionWithin(code, required) {
  const c = String(code).toLowerCase();
  const r = String(required).toLowerCase();
  return c === r || c.startsWith(`${r}-`);
}

/**
 * Does a residency list satisfy a requirement? Every listed location must lie inside
 * `required`; an empty list proves nothing and never satisfies it.
 */
export function residencyWithin(codes, required) {
  return codes.length > 0 && codes.every((c) => regionWithin(c, required));
}
