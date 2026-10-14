# FluentCards — Web App

The installable **web app** (PWA) version of [FluentCards](https://github.com/ImFluent) — turn words you don't know into flashcards with their meaning, the sentence, and a movie clip. Review daily.

This is the same app that runs as a Chrome extension, served as a plain static
site so it installs on **Android, iPhone, and Mac**. No build step, no server,
no tracking — your words live in your browser's `localStorage` and never leave
your device.

## Install it

Host this folder on any static host (GitHub Pages, Netlify, Cloudflare Pages,
Vercel), open the URL, then:

| Device | How |
| --- | --- |
| **Android** (Chrome) | menu ⋮ → **Add to Home screen** → Install |
| **iPhone / iPad** (Safari) | Share ▶ → **Add to Home Screen** |
| **Mac** (Chrome/Edge) | menu ⋮ → **Install FluentCards** |
| **Mac** (Safari 17+) | **File → Add to Dock** |

## Add words

- **Add** tab: paste or type a sentence, tap the words you want to learn.
- **Android**: highlight text in any app (e.g. YouTube subtitles) → **Share** →
  **FluentCards** → it lands in the Add tab.

## Moving words between devices

**Settings → Export** on one device, **Settings → Import** on the other. There is
no account and no server, so decks are per-device.

## What works on the web vs. the extension

- ✅ Study/review (same spaced-repetition scheduling), library, settings,
  chosen translation languages, meanings, example sentences, pronunciation,
  export/import.
- ➖ **No inline movie clips** — the clip player runs inside YouTube frames,
  which needs the browser extension. The card still shows the "hear it in
  movies" links that open those scenes on YouTube / PlayPhrase / GetYarn / TED.
- ➖ **No subtitle clicking** — injecting into youtube.com requires the
  extension. Use the Add tab instead.

## Files

```
index.html            redirects / → app.html (so it works at a host's root)
app.html / app.css / app.js   the flashcard app (study, library, add, settings)
manifest.webmanifest  PWA manifest: install icon, share target, shortcuts
sw.js                 service worker — caches the shell so it opens offline
lib/storage.js        storage + card model + scheduling (falls back to localStorage)
icons/                app icons (16–512px + maskable)
```

The dictionary and translation APIs (Wiktionary, dictionaryapi.dev, Google
Translate) are called directly from the browser — they all send
`Access-Control-Allow-Origin: *`, so no proxy or server is needed.
