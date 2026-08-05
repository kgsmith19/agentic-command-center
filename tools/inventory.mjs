// tools/inventory.mjs — ranked inventory across every OPEN-ISSUES.md ledger.
//
// Pure functions over text; the CLI at the bottom does the only I/O. Ranking is
// declared per entry (`- rank:`), never inferred here: a tool that guesses a
// priority produces a confidently wrong ordering, which is the one thing this
// file exists to prevent.

const HEADING = /^##\s+(OI-\d+)\s+(?:\[([^\]]+)\]\s*)?(.*)$/;
const FIELD = /^-\s+([a-z-]+):\s*(.*)$/i;

export function parseLedger(text, ledger) {
  const entries = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      cur = {
        id: h[1],
        qualifiedId: `${ledger}#${h[1]}`,
        ledger,
        title: h[3].trim(),
        marker: h[2] ?? null,
        fields: {},
      };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = FIELD.exec(line);
    if (f) cur.fields[f[1].toLowerCase()] = f[2].trim();
  }
  return entries;
}
