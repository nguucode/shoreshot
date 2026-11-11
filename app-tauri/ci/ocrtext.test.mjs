// Checks layoutText (src/renderer/ocrtext.ts) against real OCR output. Run: npm test (in app-tauri).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist/ocrtext.js', import.meta.url), 'utf8');
const { layoutText, translateTarget } = new Function(`${src}; return { layoutText, translateTarget };`)();
const f = (t, x, y, w, h) => ({ t, x, y, w, h });

// What macOS Vision returns for the Button docs screenshot (617×429): one fragment per line, icons misread.
const vision = [
  f('Button', 122, 54, 102, 28),
  f('Overview', 128, 108, 76, 14),
  f('Specs', 230, 108, 44, 14),
  f('Guidelines', 302, 108, 76, 12),
  f('Triggers an action on the current page, or, with href, navigates.', 120, 166, 413, 18),
  f('Beta', 126, 206, 44, 20),
  f('Button', 156, 303, 58, 18),
  f('‹> Show code', 130, 381, 86, 12),
  f('• Copy code', 240, 379, 84, 14),
];
assert.equal(
  layoutText(vision),
  `Button
Overview
Specs
Guidelines
Triggers an action on the current page, or, with href, navigates.
Beta
Button
Show code
Copy code`,
);

// Word fragments (Windows): small gaps join, wide gaps split, an inline chip stays in its sentence.
const words = [
  f('Overview', 128, 108, 76, 14), f('Specs', 230, 108, 44, 14),
  f('with', 383, 168, 30, 14), f('href', 424, 168, 34, 14), f(',', 464, 168, 4, 14), f('navigates.', 472, 168, 60, 14),
];
assert.equal(layoutText(words), 'Overview\nSpecs\nwith href, navigates.');

// Bullets: normalised to "- ", nested by x; numbers kept; a missed bullet is just a line.
const list = [
  f('• First', 20, 10, 80, 14),
  f('◦', 40, 30, 8, 14), f('Nested item', 54, 30, 90, 14),
  f('Second without a bullet', 34, 50, 160, 14),
  f('1. Numbered', 20, 70, 90, 14),
  f('- Dash', 20, 90, 50, 14),
];
assert.equal(layoutText(list), '- First\n  - Nested item\nSecond without a bullet\n1. Numbered\n- Dash');

// Real leading symbols are text; a bullet far from its text keeps it; small lines beside a big one stay apart.
assert.equal(
  layoutText([f('> npm test', 10, 10, 90, 14), f('| a | b', 10, 30, 60, 14), f('* Required', 10, 50, 80, 14)]),
  '> npm test\n| a | b\n* Required',
);
assert.equal(layoutText([f('•', 20, 10, 6, 14), f('Item', 50, 10, 30, 14)]), '- Item');
assert.equal(layoutText([f('Big', 20, 10, 80, 40), f('x', 120, 12, 10, 12), f('sub', 120, 38, 30, 12)]), 'Big\nx\nsub');

assert.equal(layoutText([]), '');
assert.equal(layoutText([f('•', 10, 10, 8, 14)]), ''); // a lone icon is not text

// An emoji misread as "•." or "{" at the start of a row is dropped, not kept as text or made a bullet.
assert.equal(layoutText([f('•. Support the channel', 20, 10, 200, 14)]), 'Support the channel');

// Wrapped lines join into their paragraph, but not across a paragraph gap; short stacked labels and bullets stay
// one per line; a wrapped bullet keeps its second line.
const prose = [
  f('Normally the podcast series is for members only. But today we decided to', 20, 10, 600, 14),
  f('make it public for everyone. This is a far more complete remake than the', 20, 30, 598, 14),
  f('old version. •', 20, 50, 90, 14),
  f('In this new script the story has been restructured into one that links to Dark', 20, 90, 602, 14),
  f('Souls 2 and Dark Souls 3.', 20, 110, 190, 14),
  f('Overview', 20, 150, 76, 14),
  f('Guidelines', 20, 170, 76, 14),
  f('• First item that is long enough to reach the right edge of the block and wrap', 20, 210, 600, 14),
  f('onto a second line', 34, 230, 130, 14),
  f('• Second', 20, 250, 70, 14),
];
assert.equal(
  layoutText(prose),
  `Normally the podcast series is for members only. But today we decided to make it public for everyone. This is a far more complete remake than the old version.
In this new script the story has been restructured into one that links to Dark Souls 2 and Dark Souls 3.
Overview
Guidelines
- First item that is long enough to reach the right edge of the block and wrap onto a second line
- Second`,
);
// A line broken at a hyphen continues without a space; a comma after a code chip loses the stray space.
assert.equal(
  layoutText([
    f('The fix is in commit 9b48219 on the branch that is called claude/translate-', 20, 10, 600, 14),
    f('scanned-text , not pushed.', 20, 30, 200, 14),
  ]),
  'The fix is in commit 9b48219 on the branch that is called claude/translate-scanned-text, not pushed.',
);

// Translate direction: Vietnamese goes to English, everything else to Vietnamese (French accents are not Vietnamese).
assert.equal(translateTarget('Sao chép văn bản'), 'en');
assert.equal(translateTarget('ĐƯỜNG DẪN'), 'en');
assert.equal(translateTarget('Copy text from area'), 'vi');
assert.equal(translateTarget('Crème brûlée à la carte'), 'vi');
console.log('ocrtext ok');
