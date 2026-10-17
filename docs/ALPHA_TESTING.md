# ClearScroll closed alpha: tester guide

Thank you for testing ClearScroll before anyone else does. This is a
**private test build**: it is not in the Chrome Web Store, and it may still
hide things it should not or miss things it should hide — finding those
cases is exactly what this alpha is for.

## 1. Install

You need Google Chrome 116 or newer (or Chromium) on a desktop computer.

**If you received a ZIP file** from the maintainer: unpack it into a folder
you will keep (Chrome loads the extension from there). **If you build from
source:** follow [Install (from source)](../README.md#install-from-source);
the result is the `dist/` folder.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unpacked folder (or `dist/`).
4. Pin ClearScroll from the puzzle-piece menu so its popup is one click away.

To update, replace the folder's contents and click the circular arrow on
ClearScroll's card in `chrome://extensions`. To remove it, click **Remove**
there; all settings are deleted with it.

## 2. Add topics

Open the popup → **Settings** (or right-click the icon → *Options*).

* Type what you do not want to see, one topic per entry: `cats`,
  `football`, `cryptocurrency`, `movie spoilers`, `Elon Musk`.
* **Concrete topics work best.** "football" or "rugby" rather than
  "sports". A broad topic hides its whole area ("sports" hides every sport).
* You can name two subjects in one topic: `football and basketball`.
* **Strictness:** *Precise* hides less and makes fewer mistakes; *Balanced*
  is the default; *Thorough* hides more and also hides more things it
  should not.
* Hidden items are blurred, not removed: click one (or press Enter on it)
  to see it. It stays visible until its text changes.
* The popup has a **Filtering enabled** switch and a **Never run on this
  site** button (press it again — *Run on this site again* — to undo).

Text is analysed on your computer by a small language model; the first
analysis after starting Chrome takes about half a second.

## 3. Pictures (optional, off by default)

**Settings → Images → Also hide pictures that show your topics** analyses
the pictures themselves (a cat
photo with no caption), with a second, larger model on your computer.

* **Cost:** about 0.4 GB more memory while active (briefly up to about
  0.9 GB when you add a new topic), and roughly 0.2 s of CPU per new
  picture on a recent laptop — more on older ones. After 5 minutes without
  pictures the model is unloaded and loads again (under 1 s) when needed.
* **Pictures appear first and are blurred a moment later** when they match;
  while scrolling fast, a few may be visible briefly.
* **"Also check pictures from other domains"** (separate switch, off by
  default): most large sites serve pictures from separate image servers
  whose pixels the browser does not let ClearScroll read in the page. With
  this on, ClearScroll downloads one more copy of such a picture — without
  your cookies — to analyse it locally; the image server sees that extra
  request. With it off, ClearScroll makes no network requests at all, and
  those pictures are simply not checked (the popup says how many).

Nothing you browse, no text and no picture is ever uploaded; there is no
account, no analytics and no telemetry.

## 4. Reporting a mistake

Mistakes come in two kinds — please report both:

* **Hidden by mistake** (a false positive): ClearScroll blurred something
  that is not about your topic.
* **Not hidden** (a false negative): something clearly about your topic
  stayed visible.

For each one, write down:

1. **Site** — the domain only (`bbc.com`, `youtube.com`), not the full address.
2. **Topic** that was involved, and the **strictness** setting.
3. **What it was** — the headline or a short description in your own words.
   Only quote text from public pages.
4. Optional: a **screenshot**, cropped so that it shows nothing personal
   (no account names, messages or other tabs).
5. Optional: Settings → *Advanced* → *Diagnostics* → **Copy diagnostics**, then paste. This
   copies the status of the extension and your settings in summary form
   (counts, on/off switches, model status). It contains no page content and
   no web addresses; your topic names are included only if you tick
   *Include my topic names*. Nothing is sent anywhere — you decide what to
   paste and where.

Send your notes through the private channel the maintainer gave you. Please
do not report from private pages (e-mail, banking, health portals); if a
mistake happens there, describe it in general terms.

## 5. Manual test checklist

Tick what you tried; note anything surprising.

- [ ] Add a topic you actually want hidden; browse your usual news and video sites for a day.
- [ ] Hidden items are blurred; click and Enter reveal them; the reveal stays.
- [ ] Unrelated articles on the same pages stay visible.
- [ ] A neighbouring subject stays visible (e.g. topic `football` on a rugby or basketball page; `cats` on a dog video search; `cryptocurrency` on a gold-price page).
- [ ] The popup's *Filtering enabled* switch and *Never run on this site* button work and are undone just as easily.
- [ ] Switch strictness to *Precise* and *Thorough* once and compare.
- [ ] Optional: turn on *Also hide pictures that show your topics*; check that matching pictures are blurred and others are not; note memory/CPU impressions.
- [ ] Optional: turn on *Also check pictures from other domains* on a large site and compare the popup's picture counts.
- [ ] Infinite feeds (scroll a long time): new items are still handled; the page stays smooth.
- [ ] Keyboard only: Tab reaches hidden items and the settings; focus is visible.

## 6. Known limitations

* **English only.** Other languages are matched by keywords only.
* **Neighbouring subjects** are mostly kept apart within sports, animals,
  finance, film and TV, technology and music. Outside those areas (for
  example politics or people), closely related subjects can still be
  confused. Texts about two subjects at once can be missed.
* **"Spoilers"** are recognised from what a text is about, not from what it
  reveals: some reviews and trailers can still be hidden.
* **Short texts** (under about 24 characters, such as labels and channel
  names) match only if they contain your topic's words.
* **Pictures:** abstract topics ("politics", "news") are rarely recognisable
  in a picture; pictures served through redirects and pictures in frames are
  not checked.
* **Whole items are hidden**: a mistake on a feed card hides the whole card.

Measured quality, privacy guarantees and design: [README](../README.md),
[privacy](PRIVACY.md), [model and evaluation](MODEL.md).
