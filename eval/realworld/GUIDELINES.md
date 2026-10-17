# Real-world evaluation set: labelling guidelines

Written before any text was labelled, and applied to the text alone — the
labeller does not see the extension's verdict or score while labelling.

## Source of the texts

Text units exactly as ClearScroll's content script extracts them
(`collectUnits` / `unitText` in `src/content/dom.ts`) from public pages
loaded in Google Chrome stable with the built extension, after scrolling
the page so lazily loaded items render (`scripts/live-capture.ts`; cookie
dialogs declined, the extension's verdicts discarded before labelling).
Navigation, menus and other protected regions are already excluded by the
extension; every other unit — headlines, summaries, captions, metadata, UI strings — is kept, because
the extension classifies all of them.

Pages that block automated browsers (Reddit, X, AP News at the time of
collection) are not included; no access controls were bypassed.

Each item records its source page and capture date. Texts are short
excerpts of public pages kept for evaluation only.

## Labels

Each text is labelled for the one topic its page was captured for:
`1` (the user who set this topic wants it hidden), `0` (they do not), or
`null` (ambiguous; excluded from metrics and reported separately).
`lang` is `en` unless the text is not English (non-English texts are
excluded from English metrics: English is the supported language).

### cryptocurrency (topic query: "cryptocurrency")

* 1 — the text is about cryptocurrencies or crypto assets: coins and
  tokens (Bitcoin, Ether, memecoins, stablecoins), crypto exchanges and
  companies, blockchain/DeFi/NFTs, crypto prices, mining, crypto
  regulation, crypto crime and scams. Crypto as one subject among others
  in the text also counts.
* 0 — stocks, markets, banking, payments or fintech without crypto; gold;
  AI; anything else; UI strings and metadata.

### football (topic query: "football")

* 1 — association football (soccer): matches, results, clubs, players,
  managers, competitions, transfers, governing bodies, football finance,
  fans and stadiums — including texts that only name clubs, players or
  competitions ("Saka responds to Arteta's challenge").
* 0 — other sports (rugby, cricket, tennis, golf, motor racing,
  basketball, …), sport in general, UI strings and metadata.
* null — American or Canadian football (NFL, college football): the
  English word "football" names a different sport in different regions.

### movie spoilers (topic query: "movie spoilers")

* 1 — the text reveals or explicitly discusses plot details, twists,
  deaths or endings of a film or TV show ("ending explained", "X dies in
  the finale"), or says it contains spoilers.
* 0 — trailers and teasers, release dates, casting, box office, reviews or
  descriptions that state no more than the premise, film news, people
  news (including obituaries), UI strings; texts marked spoiler-free.
* null — the text may contain a plot point but the labeller cannot tell
  without watching the work.

### cats (topic query: "cats"; Task 07)

* 1 — domestic cats are a subject of the text: cats, kittens, cat breeds,
  cat behaviour, health, care, food or products, cat videos, stories in
  which a cat is one of the subjects ("cats and dogs").
* 0 — other animals (dogs, horses, birds, wildlife), pets or animals in
  general without cats, anything else, UI strings and metadata.
* null — big cats (lions, tigers, leopards …) and wild felids; "Cats" the
  musical or the film; a cat mentioned only in passing in a text about
  something else; a bare file name or code from which the subject cannot
  be told ("Taska-model-6.jpg"); channel names that only hint at a subject
  ("Meow & Paws").

### dogs (topic query: "dogs"; Task 07)

The same rules with dogs and cats exchanged: 1 — domestic dogs and puppies,
breeds, training, care, dog videos, stories in which a dog is a subject;
0 — cats and other animals, pets in general without dogs; null — wolves,
foxes and other wild canids, passing mentions, uninformative file names.

### basketball (topic query: "basketball"; Task 07)

* 1 — basketball: NBA, WNBA, EuroLeague, college and national-team
  basketball, games, results, players, coaches, trades — including texts
  that only name basketball clubs or players.
* 0 — every other sport (association and American football, rugby,
  cricket, tennis …), sport in general, UI strings and metadata.
* null — a multi-sport club or person named without saying which sport.

### stock market (topic query: "stock market"; Task 07)

* 1 — stocks and shares: stock indices (S&P 500, Nasdaq, Dow, FTSE …),
  share prices and trading, company results reported as market news, IPOs,
  stock-market rallies and sell-offs, investing in shares — also when
  stocks are one of several subjects ("Bitcoin, stocks and gold fall").
* 0 — cryptocurrency, gold, commodities, currencies, interest rates or the
  economy without stocks; companies without their shares; personal finance
  without shares; UI strings and metadata.
* null — "markets" or "investing" without saying what is traded.

`lang` is `en` unless non-English words carry the meaning (Polish or Spanish
file names on Wikimedia Commons, YouTube's Turkish interface strings such as
"görüntüleme" or "bölüm", which appear because pages are served by location).

## Splits

* `dev.jsonl` — pages captured first; used for error analysis and for
  choosing any change.
* `test.jsonl` — different pages captured later, labelled before any
  evaluation on them. Inspected during Task 03; no longer treated as blind.
* `heldout.jsonl` — Task 04: pages chosen in
  `docs/evaluation/realworld/PREREGISTRATION.md`, captured after it was
  pushed, at most 120 texts per page with the card each text belongs to,
  labelled (checksum published in `MANIFEST.json`) before any prediction.

* `task07-dev.jsonl` — Task 07: pages for the topic "cats" (cat, dog,
  horse and wildlife pages, a news page), captured with no topic active
  (so no verdict existed) and labelled before any prediction; development
  data for the sibling veto, like the three splits above.
* `task07-heldout.jsonl` — Task 07 final held-out split: pages listed in
  `docs/evaluation/realworld/PREREGISTRATION-task07.md`, captured after it
  was pushed with no topic active, at most 100 distinct texts per page,
  labelled (checksum in `MANIFEST.json`) before any prediction.

The files themselves are private; see `README.md`.
