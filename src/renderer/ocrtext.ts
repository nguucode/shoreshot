// Turns OCR fragments (text + box in image pixels, top-left origin) into the text ShoreShot copies.
// macOS sends one fragment per recognized line (Vision already splits far-apart texts), Windows one per word.
//
// - Fragments on the same row are joined with a space; a gap wider than GAP × the row's text height starts a new line
//   (tabs, table cells, buttons side by side each get their own line).
// - One output line per visual line: wrapped paragraphs are not merged.
// - A bullet at the start of a row becomes "- ", indented two spaces per level. The same glyph later in a row is an
//   icon the OCR misread, and is dropped along with other icon-only tokens.

const OCR_GAP = 1.5;
const OCR_BULLETS = '•·‣◦▪■●○∙';
const OCR_ICON_GLYPHS = OCR_BULLETS + '‹›«»□▸▶►';
const ocrOnly = (token: string, chars: string) => token !== '' && [...token].every((c) => chars.includes(c));
const ocrBullet = (token: string) => ocrOnly(token, OCR_BULLETS) || token === '-';
/** A misread icon: only icon glyphs and < > |, with at least one glyph (so a real "> npm test" or "| a | b" is kept). */
const ocrIcon = (token: string) =>
  ocrOnly(token, OCR_ICON_GLYPHS + '<>|') && [...token].some((c) => OCR_ICON_GLYPHS.includes(c));

function layoutText(fragments: OcrFragment[]): string {
  // Rows: fragments whose vertical centre is close to that of the row's first fragment. "Close" is measured by the
  // smaller of the two, so small lines stacked beside a big heading stay separate; `h` (for the gap) is the tallest.
  const rows: { cy: number; h0: number; h: number; items: OcrFragment[] }[] = [];
  for (const f of [...fragments].sort((a, b) => a.y - b.y)) {
    const cy = f.y + f.h / 2;
    const row = rows.find((r) => Math.abs(cy - r.cy) < Math.max(Math.min(f.h, r.h0) / 2, r.h0 / 4));
    if (row) {
      row.items.push(f);
      row.h = Math.max(row.h, f.h);
    } else {
      rows.push({ cy, h0: f.h, h: f.h, items: [f] });
    }
  }

  const lines: { text: string; bulletX: number | null; h: number }[] = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let words: string[] = [];
    let startX = 0;
    let end = -Infinity;
    let first = true; // first segment of the row: the only place a bullet is a bullet
    const flush = () => {
      let bulletX: number | null = null;
      const head = words[0] ?? '';
      if (first && words.length > 1 && ocrBullet(head)) {
        bulletX = startX;
        words.shift();
      } else {
        while (ocrIcon(words[0] ?? '')) words.shift();
      }
      if (words.length) lines.push({ text: words.join(' '), bulletX, h: row.h });
      first = false;
      words = [];
    };
    for (const f of row.items) {
      const loneBullet = first && words.length === 1 && ocrBullet(words[0]); // a bullet keeps its text, however far
      if (words.length && !loneBullet && f.x - end > OCR_GAP * row.h) flush();
      if (!words.length) startX = f.x;
      words.push(...f.t.split(/\s+/).filter(Boolean));
      end = f.x + f.w;
    }
    flush();
  }

  // Bullet levels: each bullet column further right than the last one is one level deeper.
  // ponytail: columns are global to the scan, so a second list in a right-hand column comes out indented.
  // Scope levels to consecutive bullet lines if that turns up.
  const levels: number[] = [];
  for (const l of [...lines].filter((l) => l.bulletX !== null).sort((a, b) => a.bulletX! - b.bulletX!)) {
    if (!levels.length || l.bulletX! - levels[levels.length - 1] > l.h / 2) levels.push(l.bulletX!);
  }
  return lines
    .map((l) => {
      if (l.bulletX === null) return l.text;
      const level = levels.filter((x) => x <= l.bulletX!).length - 1;
      return `${'  '.repeat(level)}- ${l.text}`;
    })
    .join('\n');
}

/** Translate into: English if the text has letters only Vietnamese uses (ă đ ơ ư and the tone-marked vowels), else Vietnamese. */
const translateTarget = (text: string): 'vi' | 'en' => (/[ăđơư\u1EA0-\u1EF9]/i.test(text) ? 'en' : 'vi');
