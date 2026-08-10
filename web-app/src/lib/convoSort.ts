// Shared conversation-title ordering, used by both the billing Statistics
// window and the conversation Search window so they order identically.
//
// Titles follow the "<name>_<number>-<index>" convention. We compare each part
// in turn: name (locale-aware), then number (numeric), then index (numeric) —
// so 先輩_1-1 < 先輩_1-2 < 先輩_3 < 先輩_10. A bare "<name>_<number>" (no index)
// sorts before its "-N" siblings. Titles that don't fit the pattern fall to the
// end, ordered naturally.

export function parseConvoTitle(t: string): { name: string; num: number; idx: number; matched: boolean } {
  const m = t.match(/^(.*)_(\d+)(?:-(\d+))?$/);
  if (!m) return { name: t, num: Infinity, idx: Infinity, matched: false };
  return { name: m[1], num: parseInt(m[2], 10), idx: m[3] !== undefined ? parseInt(m[3], 10) : -1, matched: true };
}

export function compareConvoTitles(a: string, b: string): number {
  const pa = parseConvoTitle(a);
  const pb = parseConvoTitle(b);
  const byName = pa.name.localeCompare(pb.name, undefined, { numeric: true, sensitivity: 'base' });
  if (byName !== 0) return byName;
  if (pa.num !== pb.num) return pa.num - pb.num;
  if (pa.idx !== pb.idx) return pa.idx - pb.idx;
  return a.localeCompare(b, undefined, { numeric: true });
}
