// Turns OCR fragments (text + box in image pixels, top-left origin) into the text ShoreShot copies.
// macOS sends one fragment per recognized line (Vision already splits far-apart texts), Windows one per word.
//
// - Fragments on the same row are joined with a space; a gap wider than GAP × the row's text height starts a new line
//   (tabs, table cells, buttons side by side each get their own line).
// - A paragraph that wraps over several lines on screen comes out as one line; anything else is one line per line.
// - A bullet at the start of a row becomes "- ", indented two spaces per level. The same glyph later in a row is an
//   icon the OCR misread, and is dropped along with other icon-only tokens.

const OCR_GAP = 1.5;
const OCR_PARAGRAPH_STEP = 1.4; // × the usual line pitch: a bigger step down starts a new paragraph
const OCR_LONG_LINE = 12; // × text height: shorter lines are labels, not prose that wraps
const OCR_BULLETS = '•·‣◦▪■●○∙';
const OCR_ICON_GLYPHS = OCR_BULLETS + '‹›«»□▸▶►';
const ocrOnly = (token: string, chars: string) => token !== '' && [...token].every((c) => chars.includes(c));
const ocrBullet = (token: string) => ocrOnly(token, OCR_BULLETS) || token === '-';
/** A misread icon or emoji: no letter or digit, and at least one icon glyph ("‹>", "•."; a real "> npm test" is kept). */
const ocrIcon = (token: string) => !/[\p{L}\p{N}]/u.test(token) && [...token].some((c) => OCR_ICON_GLYPHS.includes(c));

interface OcrLine { text: string; bulletX: number | null; x: number; right: number; cy: number; h: number }

function ocrLines(fragments: OcrFragment[]): OcrLine[] {
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

  const lines: OcrLine[] = [];
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
      while (ocrIcon(words[words.length - 1] ?? '')) words.pop(); // an emoji at the end of a line
      if (words.length) lines.push({ text: words.join(' '), bulletX, x: startX, right: end, cy: row.cy, h: row.h });
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
  return lines.map((l) => {
    if (l.bulletX === null) return l;
    const level = levels.filter((x) => x <= l.bulletX!).length - 1;
    return { ...l, text: `${'  '.repeat(level)}- ${l.text}` };
  });
}

/** The text to copy (and to translate): the lines, with the wrapped lines of a paragraph joined into one. */
function layoutText(fragments: OcrFragment[]): string {
  const lines = ocrLines(fragments);
  // Blocks: runs of lines one line pitch apart. A paragraph never continues across a bigger step. The pitch is the
  // median step between lines in this scan (boxes differ too much between OCR engines to go by the gap between them).
  const steps = lines.map((l, i) => (i ? l.cy - lines[i - 1].cy : 0)).filter((d, i) => i && d > lines[i].h / 2);
  const pitch = [...steps].sort((a, b) => a - b)[Math.floor((steps.length - 1) / 2)] ?? Infinity;
  const blocks: OcrLine[][] = [];
  lines.forEach((l, i) => {
    if (!i || l.cy - lines[i - 1].cy > OCR_PARAGRAPH_STEP * pitch) blocks.push([l]);
    else blocks[blocks.length - 1].push(l);
  });
  return blocks
    .map((block) => {
      const left = Math.min(...block.map((l) => l.x));
      const width = Math.max(...block.map((l) => l.right)) - left;
      let out = '';
      block.forEach((l, i) => {
        const prev = block[i - 1];
        // A line wraps into the next one when it is long, runs to the right edge of the block, does not end a
        // sentence, and the next one is below it and not a new bullet. Short stacked labels (menus, buttons) stay
        // one per line; a line that ends a sentence keeps its break, which costs nothing.
        // ponytail: the block's own widest line stands in for the column width, so list lines of nearly equal
        // length can join. Needs the real column edge (or sentence punctuation) to tell those apart.
        const wrapped =
          prev && l.bulletX === null && l.cy - prev.cy > prev.h / 2 &&
          prev.right - prev.x > OCR_LONG_LINE * prev.h && prev.right - left > 0.85 * width &&
          !/[.!?:;…]$/.test(prev.text);
        out += (i ? (wrapped ? ' ' : '\n') : '') + l.text;
      });
      return out;
    })
    .join('\n');
}

/** Translate into: English if the text has letters only Vietnamese uses (ă đ ơ ư and the tone-marked vowels), else Vietnamese. */
const translateTarget = (text: string): 'vi' | 'en' => (/[ăđơư\u1EA0-\u1EF9]/i.test(text) ? 'en' : 'vi');
