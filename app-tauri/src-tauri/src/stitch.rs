//! Scrolling capture: stitches frames of one screen area, taken while the user scrolls down, into one tall image.
//!
//! Matching is tolerant: macOS draws text slightly differently after each scroll step (measured on TextEdit at
//! the true shift: mean difference 1.2 of 255, 94 % of rows within 8, but only 19 % of rows equal byte for
//! byte), so exact row hashes almost never line up. Instead, as j-stitch does:
//! - each row gets a profile value, its mean brightness over the left nine tenths (the right tenth is where
//!   scroll bars change);
//! - rows whose profile stays put at the top and bottom are fixed (a sticky header, a toolbar, a chat input):
//!   they stay once at the top and once at the bottom of the result;
//! - between them, the scroll offset `d` is the shift where the new profiles line up best with the last
//!   accepted frame's (the anchor). It must stand out: a blank area, or content repeating with some period
//!   (table rows, identical cards) that lines up about as well at another shift, gives `Lost` rather than a
//!   guess. The best shift is then checked pixel by pixel (9 in 10 overlapping rows must be close).
//! - No match = `Lost`, and the anchor stays: once the user scrolls back up so the frames overlap again,
//!   stitching carries on (as in PixPin).
//!
//! The result's last rows always equal the anchor's, so a new frame replaces the result's fixed bottom rows
//! with its `d` new content rows followed by its own fixed bottom rows.

/// Minimum overlap with the anchor, as a share of the scrolling part of the frame: a frame may move by up
/// to 3/4 of the area's height (at 50 frames a second, 37 heights a second). Smaller overlaps line up by
/// chance too easily.
const MIN_OVERLAP: usize = 4; // 1/4
/// Profiles closer than this (mean brightness, 0-255) count as the same row.
const SAME_ROW: f32 = 0.3;
/// The best shift must line up at least this well (mean profile difference; measured on TextEdit: about 1
/// when still, up to 1.9 while the page is still moving, against 7 or more for any other shift)...
const MAX_SCORE: f32 = 4.0;
/// ...and clearly better than any shift more than a few rows away (repeated content): the runner-up must
/// score at least twice as badly, and this much worse. Measured on a Facebook feed and a chat: a perfect
/// match (0.00) had runners-up at 0.29-0.49 (pages with large plain areas line up a little at any shift);
/// unrelated text scored 2.24 against 2.30, and truly repeating content 0 against 0. Dark, sparse pages
/// (YouTube comments) line up even more at any shift: 0.00 against 0.11-0.14. The "twice as badly" rule
/// does the work; this margin only keeps exact ties and noise out.
const DISTINCT: f32 = 0.05;
/// The overlap must have some texture (standard deviation of its profiles): a blank area can't be placed.
const MIN_TEXTURE: f32 = 2.0;
/// Pixel check: a row is close when its sampled mean difference is within this.
const CLOSE_ROW: u32 = 6;

#[derive(Debug, PartialEq)]
pub enum Step {
    /// Nothing scrolled (or only a few rows changed, like a blinking caret).
    Same,
    /// Scrolled down by this many rows; they were added.
    Added(usize),
    /// No overlap with the last accepted frame: scrolled too far, up, or the content changed.
    Lost,
}

pub struct Stitcher {
    w: usize,
    rgba: Vec<u8>,
    anchor: Vec<f32>,
    /// The most rows found fixed at the top of the area while it scrolled (a browser's tabs and address bar,
    /// a sticky header). Never written below the top of the result: a spinner in a tab makes a frame's own
    /// count of fixed rows too small.
    header: usize,
    /// Why the last `Lost` happened, for the log.
    pub why: String,
}

impl Stitcher {
    pub fn new(w: usize, frame: Vec<u8>) -> Self {
        let anchor = profiles(w, &frame);
        Stitcher { w, rgba: frame, anchor, header: 0, why: String::new() }
    }

    pub fn width(&self) -> usize {
        self.w
    }

    pub fn height(&self) -> usize {
        self.rgba.len() / (self.w * 4)
    }

    pub fn push(&mut self, frame: &[u8]) -> Step {
        let rows = profiles(self.w, frame);
        let (old, h) = (&self.anchor, rows.len());
        if h != old.len() {
            return Step::Same;
        }
        let same = |i: usize, j: usize| (rows[i] - old[j]).abs() < SAME_ROW;
        let top = (0..h).take_while(|&i| same(i, i)).count();
        let bottom = (top..h).rev().take_while(|&i| same(i, i)).count();
        // Not a scroll, something changed in place: a caret, a hover, a spinner (under 1 row in 20: nothing
        // to take), or a band in the middle with the rest unchanged (an image loading: take the new pixels).
        // The unchanged rows must hold content: on a sparse page, plain rows match at any scroll position.
        let (busy_new, busy_old) = (busy(&rows), busy(old));
        let few_changed = (0..h).filter(|&i| !same(i, i)).count() * 20 < h;
        if few_changed || (top + bottom) * 2 >= h {
            let kept_content = (0..top).chain(h - bottom..h).filter(|&i| busy_old[i]).count() >= 8;
            if !few_changed && kept_content {
                self.refresh(frame, rows, top);
            }
            return Step::Same;
        }
        let n = h - top - bottom; // the scrolling part
        let reach = (n - (n / MIN_OVERLAP).max(12)) as isize;
        // Rows i of the new frame that line up with anchor rows i + d, for a shift d (negative: scrolled up).
        let span = |d: isize| (top as isize + (-d).max(0)) as usize..(top as isize + n as isize - d.max(0)) as usize;
        let at = |i: usize, d: isize| (i as isize + d) as usize;
        // Mean difference of the best 3 in 4 rows that have content (text, edges, pictures) in the new frame
        // or the anchor: something moving by itself on the page (a video, a GIF) spoils some rows at any shift
        // and must not hide the right one, and plain background lines up at any shift, so on a sparse page
        // (YouTube comments: most rows are plain dark) it would make every shift look right.
        let score = |d: isize| {
            let mut diffs: Vec<f32> = span(d)
                .filter(|&i| busy_new[i] || busy_old[at(i, d)])
                .map(|i| (rows[i] - old[at(i, d)]).abs())
                .collect();
            if diffs.len() < 8 {
                return f32::MAX; // nothing to line up on
            }
            let keep = diffs.len() * 3 / 4;
            diffs.select_nth_unstable_by(keep - 1, f32::total_cmp);
            diffs[..keep].iter().sum::<f32>() / keep as f32
        };
        // Up shifts too: after scrolling back up past the last match, the frame lines up above it.
        let scores: Vec<(isize, f32)> = (-reach..=reach).map(|d| (d, score(d))).collect();
        let Some(&(d, best)) = scores.iter().min_by(|a, b| a.1.total_cmp(&b.1)) else { return Step::Lost };
        let runner_up = scores.iter().filter(|(e, _)| e.abs_diff(d) > 3).map(|s| s.1).fold(f32::MAX, f32::min);
        let overlap: Vec<f32> = span(d).map(|i| old[at(i, d)]).collect();
        let mean = overlap.iter().sum::<f32>() / overlap.len() as f32;
        let texture = (overlap.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / overlap.len() as f32).sqrt();
        // Shift 0: the page is where it was and part of it changed in place (images loading, a placeholder
        // filled in). No other shift to tell apart, so no distinctness rule, and a looser pixel check below.
        let in_place = d == 0;
        if best > MAX_SCORE || (!in_place && runner_up < best * 2.0 + DISTINCT) || texture < MIN_TEXTURE {
            self.why = format!(
                "best shift {d} scores {best:.2} (limit {MAX_SCORE}), next best {runner_up:.2}, texture {texture:.1} (min {MIN_TEXTURE}); {n} of {h} rows scroll"
            );
            return Step::Lost;
        }
        // Pixel check on the overlap: half the rows close to the anchor's (the result's last h rows). Images
        // that finished loading since the anchor change a third of the rows or more (Instagram: 64-75 % close
        // at shifts that lined up clearly); a different page changes nearly all of them.
        let row = self.w * 4;
        let anchor_px = &self.rgba[self.rgba.len() - h * row..];
        let r = span(d);
        let len = r.len();
        let close = r.filter(|&i| row_diff(&frame[i * row..(i + 1) * row], &anchor_px[at(i, d) * row..(at(i, d) + 1) * row]) <= CLOSE_ROW).count();
        if close * 2 < len {
            self.why = format!("best shift {d} scores {best:.2} but only {close} of {len} rows are close in pixels");
            return Step::Lost;
        }
        if d < 0 {
            return Step::Same; // above the last match: nothing new yet
        }
        if d == 0 {
            self.refresh(frame, rows, top); // in place: images loaded since the anchor
            return Step::Same;
        }
        // Scrolled down by d: the result's fixed bottom rows give way to the d new rows and the frame's own
        // fixed bottom rows. It becomes the anchor, so stitching carries on from what it shows.
        let d = d as usize;
        // The fixed header: leading rows that match their own place better than the row d below, allowing
        // 1 in 5 that match neither (a spinner in a browser tab changes every frame, so `top` stops there).
        let fixed = |i: usize| {
            let still = (rows[i] - old[i]).abs();
            still < SAME_ROW || (i + d < h && still < (rows[i] - old[i + d]).abs())
        };
        let (mut header, mut count) = (0, 0);
        for i in 0..h / 3 {
            if fixed(i) {
                count += 1;
                if count * 5 >= (i + 1) * 4 {
                    header = i + 1;
                }
            }
        }
        self.header = self.header.max(header).max(top);
        self.rgba.truncate(self.rgba.len() - bottom * row);
        self.rgba.extend_from_slice(&frame[(h - bottom - d) * row..]);
        self.anchor = rows;
        Step::Added(d)
    }

    /// The frame is where the anchor was: its rows below the fixed header replace the result's last rows (so
    /// images that loaded replace their placeholders), and it becomes the anchor.
    fn refresh(&mut self, frame: &[u8], rows: Vec<f32>, top: usize) {
        let tail = frame.len() - top.max(self.header) * self.w * 4;
        let end = self.rgba.len();
        self.rgba[end - tail..].copy_from_slice(&frame[frame.len() - tail..]);
        self.anchor = rows;
    }

    /// Nearest-neighbour thumbnail `w` wide (height capped at `max_h`): RGBA, for the live preview.
    pub fn thumbnail(&self, w: usize, max_h: usize) -> (usize, usize, Vec<u8>) {
        let (sw, sh) = (self.w, self.height());
        let h = (sh * w / sw).clamp(1, max_h);
        let w = (sw * h / sh).clamp(1, w); // narrower when the height was capped
        let mut out = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            let src = (y * sh / h) * sw * 4;
            for x in 0..w {
                let p = src + (x * sw / w) * 4;
                out.extend_from_slice(&self.rgba[p..p + 4]);
            }
        }
        (w, h, out)
    }

    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

}

/// Lays `over` (RGBA, not premultiplied: the shapes drawn on the result, on transparent) on `dst`, pixel for
/// pixel; the shorter one sets the length.
pub fn blend(dst: &mut [u8], over: &[u8]) {
    for (d, o) in dst.chunks_exact_mut(4).zip(over.chunks_exact(4)) {
        let a = u32::from(o[3]);
        if a == 0 {
            continue;
        }
        for c in 0..3 {
            d[c] = ((u32::from(o[c]) * a + u32::from(d[c]) * (255 - a) + 127) / 255) as u8;
        }
    }
}

/// Mean brightness per row over the left nine tenths.
fn profiles(w: usize, rgba: &[u8]) -> Vec<f32> {
    let used = (w - w / 10).max(1);
    rgba.chunks_exact(w * 4)
        .map(|row| {
            let sum: u32 = row[..used * 4].chunks_exact(4).map(|p| u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2])).sum();
            sum as f32 / (3 * used) as f32
        })
        .collect()
}

/// Rows with content: their profile differs from a neighbour's (plain background, however dark or light,
/// doesn't).
fn busy(p: &[f32]) -> Vec<bool> {
    (0..p.len())
        .map(|i| {
            let step = |j: usize| p.get(j).map_or(0.0, |v| (v - p[i]).abs());
            step(i.wrapping_sub(1)) + step(i + 1) > 0.5
        })
        .collect()
}

/// Mean absolute difference of two rows over the left nine tenths, every third pixel's channels.
fn row_diff(a: &[u8], b: &[u8]) -> u32 {
    let used = (a.len() / 4 - a.len() / 40).max(1) * 4;
    let (sum, n) = a[..used].chunks_exact(12).zip(b[..used].chunks_exact(12)).fold((0u32, 0u32), |(s, n), (p, q)| {
        (s + (0..3).map(|c| u32::from(p[c].abs_diff(q[c]))).sum::<u32>(), n + 3)
    });
    sum / n.max(1)
}

/// The user's scrolling speed, from the rows each frame added: now (over the last quarter second), peak, and
/// average while moving. Rows per second; the caller turns them into frame heights per second.
#[derive(Default)]
pub struct Speed {
    recent: std::collections::VecDeque<(f64, usize)>, // (time s, rows)
    pub peak: f64,
    total: usize,
    moving: f64, // seconds spent in frames that added rows
}

impl Speed {
    const WINDOW: f64 = 0.25;

    /// A frame at `t` seconds, `dt` after the one before, added `rows`. Returns the speed now.
    pub fn add(&mut self, t: f64, dt: f64, rows: usize) -> f64 {
        if rows > 0 {
            self.recent.push_back((t, rows));
            self.total += rows;
            self.moving += dt;
        }
        while self.recent.front().is_some_and(|&(at, _)| at <= t - Self::WINDOW) {
            self.recent.pop_front();
        }
        let now = self.recent.iter().map(|r| r.1).sum::<usize>() as f64 / Self::WINDOW;
        self.peak = self.peak.max(now);
        now
    }

    pub fn average(&self) -> f64 {
        if self.moving > 0.0 { self.total as f64 / self.moving } else { 0.0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 40;

    /// One row of a fake page: every 4th row blank (repeated content), the others distinct.
    fn page_row(i: usize) -> Vec<u8> {
        let v = if i % 4 == 0 { 250 } else { (i * 37 % 200) as u8 };
        (0..W * 4).map(|x| v.wrapping_add((x % 7) as u8 * (i % 4 != 0) as u8)).collect()
    }
    fn fixed_row(v: u8) -> Vec<u8> {
        vec![v; W * 4]
    }
    /// What the screen area shows at scroll position `pos`: a 12-row header, 60 rows of page, an 8-row footer.
    /// `noise` re-renders the page rows slightly (as macOS does after a scroll).
    fn frame(pos: usize, noise: u8) -> Vec<u8> {
        let mut f = Vec::new();
        (0..12).for_each(|_| f.extend(fixed_row(10)));
        for i in pos..pos + 60 {
            // Zero-mean noise: up on some pixels, down on others.
            f.extend(page_row(i).iter().enumerate().map(|(x, v)| match (x + i) % 3 {
                0 => v.saturating_add(noise),
                1 => v.saturating_sub(noise),
                _ => *v,
            }));
        }
        (0..8).for_each(|_| f.extend(fixed_row(20)));
        f
    }

    #[test]
    fn stitches_with_fixed_header_and_footer() {
        let mut s = Stitcher::new(W, frame(0, 0));
        assert_eq!(s.push(&frame(0, 0)), Step::Same);
        assert_eq!(s.push(&frame(23, 0)), Step::Added(23));
        assert_eq!(s.push(&frame(41, 0)), Step::Added(18));
        assert_eq!(s.push(&frame(120, 0)), Step::Lost); // flung past the overlap (the fake page repeats every 200 rows)
        assert_eq!(s.push(&frame(30, 0)), Step::Same); // scrolled up a little: lines up above the last match
        assert_eq!(s.push(&frame(80, 0)), Step::Added(39)); // back within reach: carries on
        let mut want = Vec::new();
        (0..12).for_each(|_| want.extend(fixed_row(10)));
        (0..140).for_each(|i| want.extend(page_row(i)));
        (0..8).for_each(|_| want.extend(fixed_row(20)));
        assert_eq!(s.height(), 12 + 140 + 8);
        assert!(s.rgba() == want, "header once, page rows 0..140 in order, footer once");
    }

    #[test]
    fn recovers_on_an_animated_page() {
        // Rows 32..38 of the page change by themselves (a video): at rest that's Same, not Lost, and after
        // losing track, coming back to the last match carries on.
        let animated = |pos: usize, t: u8| -> Vec<u8> {
            let mut f = frame(pos, 0);
            for i in pos.max(32)..(pos + 60).min(38) {
                let y = 12 + i - pos;
                f[y * W * 4..(y + 1) * W * 4].fill(t);
            }
            f
        };
        let mut s = Stitcher::new(W, animated(0, 50));
        assert_eq!(s.push(&animated(0, 90)), Step::Same);
        assert_eq!(s.push(&animated(150, 90)), Step::Lost);
        assert_eq!(s.push(&animated(0, 130)), Step::Same);
        let step = s.push(&animated(20, 170));
        assert_eq!(step, Step::Added(20), "{}", s.why);
    }

    #[test]
    fn content_loading_in_place() {
        // Page rows 20..34 are a grey placeholder until the image loads.
        let page = |pos: usize, loaded: bool| -> Vec<u8> {
            let mut f = frame(pos, 0);
            if !loaded {
                for i in pos.max(20)..(pos + 60).min(34) {
                    let y = 12 + i - pos;
                    f[y * W * 4..(y + 1) * W * 4].fill(128);
                }
            }
            f
        };
        let mut s = Stitcher::new(W, page(0, false));
        let step = s.push(&page(0, true)); // loaded while standing still
        assert_eq!(step, Step::Same, "{}", s.why);
        let step = s.push(&page(25, true));
        assert_eq!(step, Step::Added(25), "{}", s.why);
        let mut want = Vec::new();
        (0..12).for_each(|_| want.extend(fixed_row(10)));
        (0..85).for_each(|i| want.extend(page_row(i)));
        (0..8).for_each(|_| want.extend(fixed_row(20)));
        assert!(s.rgba() == want, "the placeholder was replaced by the loaded rows");
    }

    #[test]
    fn content_loaded_while_away() {
        // The image (page rows 20..35) loads while the user is scrolled further down, then they scroll on:
        // the loaded rows change 3 in 10 rows of the overlap (more than the old 3-in-4 pixel check allowed).
        let page = |pos: usize, loaded: bool| -> Vec<u8> {
            let mut f = frame(pos, 0);
            if !loaded {
                for i in pos.max(20)..(pos + 60).min(35) {
                    let y = 12 + i - pos;
                    f[y * W * 4..(y + 1) * W * 4].fill(128);
                }
            }
            f
        };
        let mut s = Stitcher::new(W, page(0, false));
        let step = s.push(&page(10, true));
        assert_eq!(step, Step::Added(10), "{}", s.why);
    }

    #[test]
    fn spinner_in_the_header_stays_out_of_the_image() {
        // A browser: 12 rows of tabs and address bar, a loading spinner on row 3 that changes every frame,
        // and an image (page rows 50..58) loading in place after scrolling.
        let page = |pos: usize, spin: u8, loaded: bool| -> Vec<u8> {
            let mut f = frame(pos, 0);
            f[3 * W * 4..4 * W * 4].fill(spin);
            if !loaded {
                for i in pos.max(50)..(pos + 60).min(58) {
                    let y = 12 + i - pos;
                    f[y * W * 4..(y + 1) * W * 4].fill(128);
                }
            }
            f
        };
        let mut s = Stitcher::new(W, page(0, 60, false));
        assert_eq!(s.push(&page(30, 90, false)), Step::Added(30));
        assert_eq!(s.push(&page(30, 120, false)), Step::Same); // only the spinner moved
        let step = s.push(&page(30, 150, true)); // the image loaded
        assert_eq!(step, Step::Same, "{}", s.why);
        let mut want = page(0, 60, true)[..12 * W * 4].to_vec(); // the first frame's tabs, once
        (0..90).for_each(|i| want.extend(page_row(i)));
        (0..8).for_each(|_| want.extend(fixed_row(20)));
        assert!(s.rgba() == want, "tabs once at the top, the loaded image in place");
    }

    #[test]
    fn sparse_dark_page() {
        // Plain dark rows with a line of text every 15 rows (3 rows tall: 80 % of rows plain), as in YouTube comments.
        let page = |pos: usize| -> Vec<u8> {
            (pos..pos + 120).flat_map(|i| fixed_row(if i % 15 < 12 { 15 } else { (40 + i * 13 % 180) as u8 })).collect()
        };
        let mut s = Stitcher::new(W, page(0));
        let step = s.push(&page(7));
        assert_eq!(step, Step::Added(7), "{}", s.why);
        assert_eq!(s.push(&page(40)), Step::Added(33));
    }

    #[test]
    fn tolerates_rendering_noise() {
        let mut s = Stitcher::new(W, frame(0, 0));
        assert_eq!(s.push(&frame(0, 1)), Step::Same);
        assert_eq!(s.push(&frame(17, 1)), Step::Added(17));
        assert_eq!(s.push(&frame(40, 2)), Step::Added(23));
        assert_eq!(s.height(), 12 + 100 + 8);
    }

    #[test]
    fn blank_or_repeating_area_is_not_a_match() {
        let blank: Vec<u8> = (0..80).flat_map(|_| fixed_row(250)).collect();
        let mut half = blank.clone();
        half[..W * 4 * 40].copy_from_slice(&(0..40).flat_map(page_row).collect::<Vec<_>>());
        assert!(!matches!(Stitcher::new(W, blank).push(&half), Step::Added(_))); // nothing to line up on
        // Stripes every 10 rows: a shift of 3 lines up as well as 13 or 23.
        let stripes = |pos: usize| -> Vec<u8> { (pos..pos + 80).flat_map(|i| fixed_row(if i % 10 < 5 { 40 } else { 200 })).collect() };
        assert_eq!(Stitcher::new(W, stripes(0)).push(&stripes(3)), Step::Lost);
    }

    #[test]
    fn blends_shapes() {
        let mut px = vec![100, 100, 100, 255, 0, 0, 0, 255];
        blend(&mut px[4..], &[255, 0, 0, 255, 9, 9, 9, 255]); // opaque red on pixel 1; extra input ignored
        blend(&mut px, &[200, 200, 200, 0]); // transparent: unchanged
        assert_eq!(px, [100, 100, 100, 255, 255, 0, 0, 255]);
        blend(&mut px, &[200, 0, 0, 128]);
        assert_eq!(px[..3], [150, 50, 50]);
    }

    #[test]
    fn speed() {
        let mut v = Speed::default();
        // 50 frames a second, 20 rows each: 1,000 rows/s.
        let mut now = 0.0;
        for i in 1..=50 {
            now = v.add(f64::from(i) * 0.02, 0.02, 20);
        }
        // Now: the frames inside the last quarter second (12 of 12.5), so within 5 %.
        assert!((now - 1000.0).abs() < 50.0 && (v.average() - 1000.0).abs() < 1.0);
        // A pause: the speed drops to 0, the peak and average stay.
        assert_eq!(v.add(2.0, 0.02, 0), 0.0);
        assert!((v.peak - 1000.0).abs() < 50.0 && (v.average() - 1000.0).abs() < 1.0);
    }

    #[test]
    fn thumbnail_keeps_the_aspect() {
        let s = Stitcher::new(W, frame(0, 0));
        let (w, h, px) = s.thumbnail(20, 1000);
        assert_eq!((w, h, px.len()), (20, 40, 20 * 40 * 4));
        assert_eq!(s.thumbnail(20, 10).0, 5); // capped height: narrower
    }
}

/// Manual check on the real screen: grabs an area (SHORESHOT_AREA="x,y,w,h", points of the main display) as
/// fast as it can for 10 s while someone scrolls it, then writes the stitched PNG to SHORESHOT_OUT.
/// `cargo test --release real_screen -- --ignored --nocapture`
#[cfg(test)]
#[test]
#[ignore]
fn real_screen() {
    let area: Vec<u32> = std::env::var("SHORESHOT_AREA").unwrap().split(',').map(|v| v.parse().unwrap()).collect();
    let mon = xcap::Monitor::from_point(area[0] as i32 + 1, area[1] as i32 + 1).unwrap();
    let grab = || mon.capture_region(area[0], area[1], area[2], area[3]).unwrap();
    let first = grab();
    let w = first.width() as usize;
    let mut s = Stitcher::new(w, first.into_raw());
    let t = std::time::Instant::now();
    let mut frames = 0;
    while t.elapsed() < std::time::Duration::from_secs(10) {
        frames += 1;
        let step = s.push(&grab().into_raw());
        if step != Step::Same {
            println!("{:>5} ms {step:?} -> {} px", t.elapsed().as_millis(), s.height());
        }
        if step == Step::Lost {
            println!("        {}", s.why);
        }
    }
    println!("{frames} frames in 10 s");
    let out = std::env::var("SHORESHOT_OUT").unwrap();
    xcap::image::save_buffer(out, s.rgba(), w as u32, s.height() as u32, xcap::image::ExtendedColorType::Rgba8).unwrap();
}
