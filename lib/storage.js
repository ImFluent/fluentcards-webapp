/* =============================================================================
 * FluentCards — shared storage, card model and spaced-repetition logic.
 *
 * Loaded by:  - extension pages  (popup.html / app.html)
 *             - content script   (youtube.com)
 *             - background worker (background.js)
 *             - plain pages      (opened from file://, for testing / offline use)
 *
 * Storage backend:
 *             - chrome.storage.local when the extension API is available
 *             - localStorage otherwise, so everything still works standalone
 * ========================================================================== */
(function (root) {
  "use strict";

  var HAS_EXT_STORAGE =
    typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);

  var P = "fc:"; // key prefix

  /* ---------------------------------------------------------------- storage */
  function chromeGet(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(keys, function (items) {
          resolve(items || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }
  function chromeSet(items) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(items, function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }
  function chromeRemove(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.remove(keys, function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  var hasLS = (function () {
    try {
      if (typeof localStorage === "undefined") return false;
      var t = P + "__t";
      localStorage.setItem(t, "1");
      localStorage.removeItem(t);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function lsParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function storeGet(keys) {
    if (HAS_EXT_STORAGE) return chromeGet(keys);
    if (!hasLS) return Promise.resolve({});
    var out = {};
    var list;
    if (keys === null || keys === undefined) {
      list = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(P) === 0) list.push(k);
      }
    } else if (typeof keys === "string") {
      list = [keys];
    } else {
      list = keys;
    }
    list.forEach(function (k) {
      var v = localStorage.getItem(k);
      if (v !== null) out[k] = lsParse(v);
    });
    return Promise.resolve(out);
  }

  function storeSet(items) {
    if (HAS_EXT_STORAGE) return chromeSet(items);
    if (!hasLS) return Promise.resolve();
    Object.keys(items).forEach(function (k) {
      try {
        localStorage.setItem(k, JSON.stringify(items[k]));
      } catch (e) {
        /* quota */
      }
    });
    return Promise.resolve();
  }

  function storeRemove(keys) {
    if (HAS_EXT_STORAGE) return chromeRemove(keys);
    if (!hasLS) return Promise.resolve();
    (typeof keys === "string" ? [keys] : keys).forEach(function (k) {
      localStorage.removeItem(k);
    });
    return Promise.resolve();
  }

  /* Fires when data changes in another document/tab. */
  function onChange(cb) {
    if (HAS_EXT_STORAGE && typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "local") cb(changes);
      });
      return;
    }
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", function (e) {
        if (e.key && e.key.indexOf(P) === 0) {
          var change = {};
          change[e.key] = { newValue: e.newValue };
          cb(change);
        }
      });
    }
  }

  /* ------------------------------------------------------------------ words */
  function cleanDisplay(word) {
    return String(word || "")
      .replace(/^[\s"'“”‘’(\[\{<.,;:!?…\-–—*/\\]+/, "")
      .replace(/[\s"'“”‘’)\]\}>.,;:!?…\-–—*/\\]+$/, "")
      .trim();
  }

  function normalize(word) {
    var w = cleanDisplay(word).toLowerCase();
    try {
      w = w.replace(/[^\p{L}\p{N}'’-]/gu, "");
    } catch (e) {
      w = w.replace(/[^a-z0-9''-]/g, "");
    }
    w = w.replace(/^['’-]+/, "").replace(/['’-]+$/, "");
    return w;
  }

  function cardKey(norm) {
    return P + "card:" + norm;
  }

  /* ------------------------------------------------------------------- time */
  function startOfDay(t) {
    var d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function dayKey(t) {
    var d = new Date(t);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  function isSameDay(a, b) {
    return startOfDay(a) === startOfDay(b);
  }
  function yesterdayKey(t) {
    return dayKey(t - 86400000);
  }
  function nextMorning(t, hour) {
    return startOfDay(t) + 86400000 + (hour || 8) * 3600000;
  }

  function fmtMs(ms) {
    if (ms <= 0) return "now";
    var m = Math.round(ms / 60000);
    if (m < 60) return m <= 1 ? "in a minute" : "in " + m + " min";
    var h = Math.round(m / 60);
    if (h < 24) return "in " + h + " h";
    var d = Math.round(h / 24);
    if (d === 1) return "tomorrow";
    if (d < 30) return "in " + d + " days";
    var mo = Math.round(d / 30);
    return "in " + mo + " mo";
  }

  function fmtInterval(days) {
    if (days <= 0) return "10 min";
    if (days === 1) return "1 day";
    if (days < 30) return days + " days";
    var mo = Math.round(days / 30);
    return mo <= 1 ? "1 month" : mo + " months";
  }

  /* ------------------------------------------------------------- languages */
  /* The languages meanings and sentences can be translated into. The native
     name is what shows on the card and in the mini card, so you can tell
     several translation lines apart at a glance. */
  var LANGS = [
    { code: "fa", name: "فارسی", en: "Persian" },
    { code: "ar", name: "العربية", en: "Arabic" },
    { code: "es", name: "Español", en: "Spanish" },
    { code: "fr", name: "Français", en: "French" },
    { code: "de", name: "Deutsch", en: "German" },
    { code: "tr", name: "Türkçe", en: "Turkish" },
    { code: "ru", name: "Русский", en: "Russian" },
    { code: "uk", name: "Українська", en: "Ukrainian" },
    { code: "zh", name: "中文", en: "Chinese" },
    { code: "ja", name: "日本語", en: "Japanese" },
    { code: "ko", name: "한국어", en: "Korean" },
    { code: "hi", name: "हिन्दी", en: "Hindi" },
    { code: "ur", name: "اردو", en: "Urdu" },
    { code: "bn", name: "বাংলা", en: "Bengali" },
    { code: "id", name: "Bahasa Indonesia", en: "Indonesian" },
    { code: "ms", name: "Bahasa Melayu", en: "Malay" },
    { code: "pt", name: "Português", en: "Portuguese" },
    { code: "it", name: "Italiano", en: "Italian" },
    { code: "nl", name: "Nederlands", en: "Dutch" },
    { code: "pl", name: "Polski", en: "Polish" },
    { code: "sv", name: "Svenska", en: "Swedish" },
    { code: "vi", name: "Tiếng Việt", en: "Vietnamese" },
    { code: "th", name: "ไทย", en: "Thai" },
    { code: "he", name: "עברית", en: "Hebrew" },
    { code: "el", name: "Ελληνικά", en: "Greek" },
    { code: "cs", name: "Čeština", en: "Czech" },
    { code: "ro", name: "Română", en: "Romanian" },
    { code: "hu", name: "Magyar", en: "Hungarian" }
  ];
  var LANG_MAP = {};
  for (var lg = 0; lg < LANGS.length; lg++) LANG_MAP[LANGS[lg].code] = LANGS[lg].name;

  function langName(code) {
    return LANG_MAP[String(code || "").toLowerCase()] || code;
  }

  /** Validate a stored/user-picked list: known codes only, unique, max 3.
      Returns null when the input wasn't an array at all. */
  function sanitizeTrLangs(v) {
    if (!Array.isArray(v)) return null;
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var c = String(v[i] || "").toLowerCase();
      if (c && c !== "en" && LANG_MAP[c] && out.indexOf(c) < 0) out.push(c);
    }
    return out.slice(0, 3);
  }

  /* --------------------------------------------------------------- defaults */
  var DEFAULT_SETTINGS = {
    enabled: true, // click-to-save on YouTube
    lang: "en", // dictionary language
    explainIn: "en", // which language a card explains first (en | any trLangs code)
    trLangs: ["fa", "ar"], // languages meanings & sentences translate into
    newPerDay: 15, // new words introduced per day (0 = unlimited)
    reminder: "20:00", // daily reminder time, "" = off
    theme: "auto", // auto | light | dark
    showHints: true // underline unknown words in captions
  };

  var DEFAULT_STATS = {
    streak: 0,
    lastStudyDay: "",
    reviewsToday: 0,
    reviewsDay: "",
    totalReviews: 0,
    newStudied: 0,
    newStudiedDay: "",
    mastered: 0
  };

  async function getSettings() {
    var o = await storeGet(P + "settings");
    var stored = o[P + "settings"] || {};
    var s = Object.assign({}, DEFAULT_SETTINGS, stored);
    /* an old save without the key keeps the default; a saved (possibly
       empty) list is validated against the known languages */
    s.trLangs =
      "trLangs" in stored
        ? sanitizeTrLangs(stored.trLangs) || []
        : DEFAULT_SETTINGS.trLangs.slice();
    return s;
  }

  async function saveSettings(patch) {
    patch = patch || {};
    if ("trLangs" in patch)
      patch = Object.assign({}, patch, { trLangs: sanitizeTrLangs(patch.trLangs) || [] });
    var cur = await getSettings();
    var next = Object.assign({}, cur, patch);
    var o = {};
    o[P + "settings"] = next;
    await storeSet(o);
    return next;
  }

  async function getStats() {
    var o = await storeGet(P + "stats");
    return Object.assign({}, DEFAULT_STATS, o[P + "stats"] || {});
  }

  async function saveStats(patch) {
    var cur = await getStats();
    var next = Object.assign({}, cur, patch || {});
    var o = {};
    o[P + "stats"] = next;
    await storeSet(o);
    return next;
  }

  /* ------------------------------------------------------------------ cards */
  async function listCards() {
    var all = await storeGet(null);
    var out = [];
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(P + "card:") === 0 && all[k] && typeof all[k] === "object") {
        out.push(all[k]);
      }
    });
    out.forEach(function (c) {
      if (!c.srs) c.srs = { reps: 0, ease: 2.5, interval: 0, due: c.createdAt || Date.now(), lapses: 0 };
      if (!c.status) c.status = c.srs.interval >= 21 ? "mastered" : c.srs.reps > 0 ? "review" : "new";
    });
    return out;
  }

  async function getCard(norm) {
    var o = await storeGet(cardKey(norm));
    return o[cardKey(norm)] || null;
  }

  async function saveCard(card) {
    if (!card || !card.norm) return;
    var o = {};
    o[cardKey(card.norm)] = card;
    await storeSet(o);
  }

  async function deleteCard(norm) {
    await storeRemove(cardKey(norm));
  }

  async function importCards(cards) {
    var items = {};
    var count = 0;
    (cards || []).forEach(function (c) {
      if (!c || !c.word) return;
      var norm = normalize(c.word);
      if (!norm) return;
      c.norm = norm;
      c.id = norm;
      c.createdAt = c.createdAt || Date.now();
      c.srs = c.srs || { reps: 0, ease: 2.5, interval: 0, due: c.createdAt, lapses: 0 };
      c.status = c.status || "new";
      items[cardKey(norm)] = c;
      count++;
    });
    await storeSet(items);
    return count;
  }

  async function resetAll() {
    var all = await storeGet(null);
    var keys = Object.keys(all).filter(function (k) {
      return k.indexOf(P) === 0;
    });
    if (keys.length) await storeRemove(keys);
  }

  /** Builds a card from a word clicked in a video caption. */
  async function createCard(fields) {
    var norm = normalize(fields.word);
    if (!norm) return { card: null, created: false, reason: "empty" };

    var existing = await getCard(norm);
    if (existing) {
      /* the same word clicked again in a new sentence: make sure the stored
         sense still fits — cards saved by older versions kept whatever the
         dictionary listed first ("Liver" → "From or pertaining to
         Liverpool." in a sentence about the body) */
      try {
        await healSense(existing, fields.context || "");
      } catch (e) {
        /* healing is best-effort — the card is still shown either way */
      }
      return { card: existing, created: false, reason: "duplicate" };
    }

    var settings = await getSettings();
    var now = fields.createdAt || Date.now();
    var all = await listCards();

    var createdToday = all.filter(function (c) {
      return c.status === "new" && isSameDay(c.createdAt || 0, now);
    }).length;

    var due = now;
    if (settings.newPerDay > 0 && createdToday >= settings.newPerDay) {
      due = nextMorning(now, 8);
    }

    var card = {
      id: norm,
      norm: norm,
      word: cleanDisplay(fields.word),
      meaning: fields.meaning || "",
      definitions: fields.definitions || [],
      meaningSource: fields.meaning ? fields.meaningSource || "manual" : "",
      context: (fields.context || "").replace(/\s+/g, " ").trim().slice(0, 400),
      videoId: fields.videoId || "",
      videoUrl: fields.videoUrl || "",
      timeSec: typeof fields.timeSec === "number" ? Math.round(fields.timeSec) : 0,
      title: (fields.title || "").slice(0, 160),
      createdAt: now,
      status: "new",
      srs: { reps: 0, ease: 2.5, interval: 0, due: due, lapses: 0 }
    };

    await saveCard(card);
    return { card: card, created: true };
  }

  /**
   * Re-check a saved card's sense against the sentence it was just clicked
   * in. With two or more stored senses the list is re-ranked and the meaning
   * only changes when another sense fits clearly better; with a single
   * stored sense there is nothing to choose from, so the word is looked up
   * again (case-correctly). A changed meaning drops the old Persian/Arabic
   * lines — they translated the wrong sense.
   */
  async function healSense(card, context) {
    if (!card || !context) return false;
    var word = card.word || "";
    var defs = Array.isArray(card.definitions) ? card.definitions : [];
    var changed = false;

    if (defs.length >= 2) {
      var ranked = rankDefs(defs, context, word);
      var top = ranked[0];
      if (top && top.text !== defs[0].text) {
        var topScore = senseScore(top, context, word, 0);
        var curScore = senseScore(defs[0], context, word, 0);
        /* a tie-break is not worth moving a learned card around */
        if (topScore > curScore + 2) {
          card.definitions = ranked;
          if (card.meaning !== top.text) {
            card.meaning = top.text.length > 220 ? top.text.slice(0, 217).trim() + "…" : top.text;
            changed = true;
          }
        }
      }
    } else {
      var got = null;
      try {
        got = await lookupDefs(word, "en", context);
      } catch (e) {
        got = null;
      }
      if (got && got.meaning && got.meaning !== card.meaning) {
        card.definitions = got.definitions || [];
        card.meaning = got.meaning;
        card.meaningSource = got.source;
        changed = true;
      }
    }

    if (changed) {
      card.translations = {};
      try {
        await saveCard(card);
      } catch (e) {
        /* still shown for this session */
      }
    }
    return changed;
  }

  /* ------------------------------------------------- spaced repetition (SM-2) */
  var GRADES = ["again", "hard", "good", "easy"];

  function gradeLabel(card, grade) {
    var probe = {
      srs: Object.assign({}, card.srs),
      status: card.status,
      createdAt: card.createdAt
    };
    schedule(probe, grade, Date.now());
    var iv = probe.srs.interval;
    return iv > 0 ? fmtInterval(iv) : "10 min";
  }

  /**
   * Applies a review grade and returns the next due interval in days.
   * Mutates the card's srs/status fields.
   */
  function schedule(card, grade, now) {
    now = now || Date.now();
    var s = card.srs || (card.srs = { reps: 0, ease: 2.5, interval: 0, due: now, lapses: 0 });

    if (grade === "again") {
      s.lapses = (s.lapses || 0) + 1;
      s.reps = 0;
      s.interval = 0;
      s.ease = Math.max(1.3, (s.ease || 2.5) - 0.2);
      s.due = now + 10 * 60000;
      card.status = "learning";
      return 0;
    }

    s.reps = (s.reps || 0) + 1;
    var ease = typeof s.ease === "number" && s.ease > 0 ? s.ease : 2.5;
    var iv = s.interval || 0;

    if (grade === "hard") {
      ease = Math.max(1.3, ease - 0.15);
      iv = iv <= 0 ? 1 : Math.max(1, Math.round(iv * 1.2));
    } else if (grade === "good") {
      iv = iv <= 0 ? 1 : iv === 1 ? 3 : Math.max(1, Math.round(iv * ease));
    } else if (grade === "easy") {
      ease = Math.min(3.2, ease + 0.15);
      iv = iv <= 0 ? 4 : Math.max(2, Math.round(iv * ease * 1.3));
    }

    s.ease = ease;
    s.interval = iv;
    s.due = now + iv * 86400000;
    card.status = iv >= 21 ? "mastered" : s.reps <= 2 ? "learning" : "review";
    return iv;
  }

  function statusLabel(card) {
    if (card.status === "new") return "New";
    if (card.status === "mastered") return "Mastered";
    if (card.status === "learning") return card.srs.reps > 0 ? "Learning" : "New";
    return "Reviewing";
  }

  function dueLabel(card, now) {
    now = now || Date.now();
    if (card.srs.due <= now) return "Due now";
    return fmtMs(card.srs.due - now);
  }

  /**
   * The ordered queue for a study session:
   * overdue reviews first (oldest due date), then new words up to the daily cap.
   */
  function buildQueue(cards, settings, stats, now) {
    now = now || Date.now();
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    stats = Object.assign({}, DEFAULT_STATS, stats || {});

    var due = cards.filter(function (c) {
      return c.srs.due <= now;
    });

    var reviews = due
      .filter(function (c) {
        return c.status !== "new";
      })
      .sort(function (a, b) {
        return a.srs.due - b.srs.due;
      });

    var fresh = due
      .filter(function (c) {
        return c.status === "new";
      })
      .sort(function (a, b) {
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

    if (settings.newPerDay > 0) {
      var used = stats.newStudiedDay === dayKey(now) ? stats.newStudied : 0;
      fresh = fresh.slice(0, Math.max(0, settings.newPerDay - used));
    }

    return reviews.concat(fresh);
  }

  /** Records a completed review in the daily statistics. */
  function recordReview(stats, wasNew, now) {
    now = now || Date.now();
    stats = Object.assign({}, DEFAULT_STATS, stats || {});

    if (stats.reviewsDay !== dayKey(now)) {
      stats.reviewsToday = 0;
      stats.reviewsDay = dayKey(now);
      stats.newStudied = 0;
      stats.newStudiedDay = dayKey(now);
      stats.streak =
        stats.lastStudyDay === yesterdayKey(now) ? stats.streak + 1 : 1;
    }
    if (!stats.lastStudyDay) stats.streak = Math.max(1, stats.streak);

    stats.lastStudyDay = dayKey(now);
    stats.reviewsToday = (stats.reviewsToday || 0) + 1;
    stats.totalReviews = (stats.totalReviews || 0) + 1;

    if (wasNew) {
      if (stats.newStudiedDay !== dayKey(now)) {
        stats.newStudiedDay = dayKey(now);
        stats.newStudied = 0;
      }
      stats.newStudied = (stats.newStudied || 0) + 1;
    }
    return stats;
  }

  /* --------------------------------------------------------------- meanings */
  function stripHtml(s) {
    return String(s || "")
      .replace(/<style[\s\S]*?<\/?style>/gi, "")
      .replace(/<script[\s\S]*?<\/?script>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      /* wiki leftovers: templates and CSS rules that survive tag stripping */
      .replace(/\{\{[^{}]*\}\}/g, "")
      .replace(/(^|[\s.;])\.[\w-]+(?:\s+[\w.#-]+)*\s*\{[^}]*\}/g, "$1")
      /* category headers such as "Terms relating to animals." are not definitions */
      .replace(/(^|\s)Terms relating to [^.]*\.\s*/gi, "$1")
      .replace(/\[\s*\d+\s*\]/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  /** Normalised comparison used to reject a result for a different word. */
  function sameWord(a, b) {
    var x = normalize(a);
    var y = normalize(b);
    return !!x && !!y && x === y;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Duolingo-style plain-English explanation: short phrase, no parentheses,
   * no trailing clauses, leading article lower-cased.
   *   "A hard rubber disc; any other flat disc meant to be hit …"  ->  "a hard rubber disc"
   */
  function simpleExplain(text) {
    var t = stripHtml(text);
    if (!t) return "";
    t = t.replace(/\([^()]*\)/g, " "); // drop parenthetical asides
    t = t.split(";")[0]; // keep the first sense
    t = t.split(" — ")[0].split(" – ")[0];
    if (t.length > 90) {
      var first = t.match(/^[^.?!]{1,90}[.?!]/); // first sentence when long
      if (first) t = first[0];
    }
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/^(A|An|The)\s/i, function (m) {
      return m.toLowerCase();
    });
    return t.replace(/[.?!]+$/, "").trim();
  }

  /**
   * Short, real English sentences that contain the word — the "Example
   * sentences" list on the study card. Source: Tatoeba (CC BY 2.0).
   * One request returns every candidate, so asking for 4 costs the same as 1.
   */
  async function fetchExamples(word, limit) {
    var w = cleanDisplay(word);
    if (!w) return [];
    var url =
      "https://tatoeba.org/en/api_v0/search?from=eng&limit=40&query=" + encodeURIComponent(w);
    var res = null;
    /* Tatoeba occasionally times out or throttles — one retry keeps the card
       from silently ending up with no sentences at all. */
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        res = await withTimeout(fetch(url), 7000);
        if (res.ok) break;
      } catch (e) {
        res = null;
      }
      if (attempt < 2) {
        await new Promise(function (r) {
          setTimeout(r, 600 * (attempt + 1));
        });
      }
    }
    if (!res || !res.ok) throw new Error("tatoeba unavailable");
    var json = await res.json();
    var list = (json && json.results) || [];
    var re = new RegExp("\\b" + escapeRe(w) + "\\b", "i");
    var hits = list.filter(function (s) {
      return s && s.lang === "eng" && s.text && re.test(s.text);
    });
    hits.sort(function (a, b) {
      return a.text.length - b.text.length;
    });

    var want = Math.max(1, limit || 4);
    var out = [];
    var seen = {};
    for (var i = 0; i < hits.length && out.length < want; i++) {
      var t = stripHtml(hits[i].text);
      if (t.length < 15 || t.length > 140) continue;
      var key = t.toLowerCase();
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(t);
    }
    if (!out.length && hits.length) out.push(stripHtml(hits[0].text));
    return out;
  }

  /** The single "Example" sentence (kept for existing cards and callers). */
  async function fetchExample(word) {
    var list = await fetchExamples(word, 1);
    return list.length ? list[0] : "";
  }

  /* ------------------------------------------------- pronunciation & clips */
  /** IPA transcription from Wiktionary's wikitext — "" when it has none. */
  async function fetchPronunciation(word) {
    var w = cleanDisplay(word);
    if (!w) return "";
    var url =
      "https://en.wiktionary.org/w/api.php?action=parse&page=" +
      encodeURIComponent(w) +
      "&prop=wikitext&format=json&formatversion=2&origin=*";
    var res = await withTimeout(fetch(url), 7000);
    if (!res.ok) throw new Error("wiktionary wikitext " + res.status);
    var json = await res.json();
    var wt = (json && json.parse && json.parse.wikitext) || "";
    var m = wt.match(/\{\{IPA\|en\|\/([^/|]+)\/[^}]*\}\}/i);
    if (m) return "/" + m[1] + "/";
    m = wt.match(/\{\{IPA\|en\|([^}|]+)\}\}/i);
    return m ? m[1].trim() : "";
  }

  function timeToSeconds(s) {
    var parts = String(s || "").split(":");
    if (parts.length > 3 || !parts.length) return 0;
    var sec = 0;
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (!isFinite(n)) return 0;
      sec = sec * 60 + n;
    }
    return sec;
  }

  /**
   * Video list out of a YouTube results page (its embedded ytInitialData).
   * Used to show real clips where the word is spoken — films, TV, cartoons.
   */
  /**
   * Pull a JSON object out of a YouTube HTML page: find `marker`, then take
   * the balanced `{…}` that follows it (the page itself is JavaScript, so a
   * plain JSON.parse can't work). Tries every occurrence of the marker.
   */
  function extractJsonObject(text, marker) {
    var src = String(text || "");
    var from = 0;
    while (from < src.length) {
      var anchor = src.indexOf(marker, from);
      if (anchor < 0) return null;
      from = anchor + marker.length;
      var start = src.indexOf("{", anchor);
      if (start < 0) return null;

      var depth = 0;
      var end = -1;
      var inStr = false;
      var escSeq = false;
      for (var p = start; p < src.length; p++) {
        var c = src.charAt(p);
        if (escSeq) {
          escSeq = false;
          continue;
        }
        if (c === "\\") {
          escSeq = true;
          continue;
        }
        if (c === '"') inStr = !inStr;
        if (inStr) continue;
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            end = p + 1;
            break;
          }
        }
      }
      if (end < 0) return null;
      try {
        return JSON.parse(src.slice(start, end));
      } catch (e) {
        /* not the object we wanted — look for the next occurrence */
      }
    }
    return null;
  }

  function parseYouTubeSearch(html) {
    var data = extractJsonObject(html, "ytInitialData");
    if (!data) return [];

    var found = [];
    (function walk(node) {
      if (!node || typeof node !== "object" || found.length > 80) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      if (node.videoRenderer) {
        found.push(node.videoRenderer);
        return;
      }
      if (node.videoWithContextRenderer) {
        found.push(node.videoWithContextRenderer);
        return;
      }
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
      }
    })(data);

    var runText = function (f) {
      if (!f) return "";
      if (f.simpleText) return f.simpleText;
      return (f.runs || [])
        .map(function (r) {
          return r.text || "";
        })
        .join("");
    };

    var out = [];
    var seen = {};
    for (var i = 0; i < found.length; i++) {
      var v = found[i];
      if (!v || !v.videoId || seen[v.videoId]) continue;
      var title = runText(v.title);
      if (!title) continue;
      var duration = runText(v.lengthText);
      var seconds = timeToSeconds(duration);
      /* clip-length only: skip full episodes, songs and 3-second stubs */
      if (seconds && (seconds < 15 || seconds > 2400)) continue;
      var thumbs = (v.thumbnail && v.thumbnail.thumbnails) || [];
      seen[v.videoId] = 1;
      out.push({
        id: v.videoId,
        url: "https://www.youtube.com/watch?v=" + v.videoId,
        title: title,
        channel: runText(v.ownerText) || runText(v.shortBylineText),
        duration: duration,
        thumb: thumbs.length ? thumbs[thumbs.length - 1].url : ""
      });
    }
    return out;
  }

  /* ------------------------------------------------------- the exact moment */
  /**
   * Where in the captions is `query` spoken? Cues are joined first so a word
   * split across two captions still matches; every character remembers which
   * cue it came from, so the answer maps straight back to a timestamp.
   */
  function findMoment(cues, query) {
    if (!cues || !cues.length) return null;
    var clean = function (s) {
      /* length-preserving: anything that isn't a letter/digit becomes a
         space, so indices in the cleaned text still point at the original */
      return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, " ");
    };
    var parts = String(query || "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (!parts.length) return null;
    var pattern = parts
      .map(function (p) {
        return escapeRe(p);
      })
      .join(" +");
    var re = new RegExp("(^| )" + pattern + "( |$)");

    /* Two passes: captions usually break mid-sentence (join with a space),
       but a long word can be split across two cues (join with nothing). */
    var scan = function (sep) {
      var text = "";
      var owner = [];
      for (var i = 0; i < cues.length; i++) {
        var chunk = clean(cues[i].text);
        for (var k = 0; k < chunk.length; k++) owner.push(i);
        text += chunk;
        for (var s2 = 0; s2 < sep.length; s2++) owner.push(i);
        text += sep;
      }

      var m = re.exec(text);
      if (!m) return null;
      var at = m.index + m[1].length;
      var len = m[0].length - m[1].length - m[2].length;
      var first = owner[at];
      var last = owner[Math.min(at + len - 1, owner.length - 1)];
      if (first === undefined || last === undefined) return null;

      var start;
      var end;
      if (cues[first].line !== undefined && cues[first].line === cues[last].line) {
        /* one caption line: play the whole sentence the word sits in */
        start = Math.max(0, cues[first].lineStart - 0.4);
        end = Math.min(cues[last].lineEnd + 1.4, start + 12);
      } else {
        start = Math.max(0, cues[first].start - 0.5);
        end = Math.min(cues[last].end + 1.6, start + 12);
      }
      if (end <= start) end = start + 3;
      return { start: start, end: end };
    };

    return scan(" ") || scan("");
  }

  /* ------------------------------------------------------------- captions */
  /*
   * YouTube signs the web player's caption URLs with a proof-of-origin token
   * that only its own player JavaScript can mint, so fetching those URLs from
   * a page answers 200 with an empty body. The Android app's player API still
   * hands out signed caption URLs that work — so we ask for captions the way
   * the YouTube app does.
   */
  var YT_ANDROID = {
    key: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
    version: "20.10.38",
    sdk: 35
  };

  /** The video's English caption track (a signed URL), or null if none. */
  async function fetchCaptionTrack(videoId) {
    return (await fetchPlayerInfo(videoId)).track;
  }

  /** A video URL the browser can play directly — small mp4, complete.
   *  (Same picker as bridge.js; this copy serves the no-bridge fallback.) */
  function pickStream(sd) {
    var formats = (sd && sd.formats) || [];
    var best = null;
    for (var i = 0; i < formats.length; i++) {
      var f = formats[i];
      if (!f || !f.url || f.signatureCipher || f.cipher) continue;
      var mp4 = /mp4/i.test(f.mimeType || "");
      var score = (mp4 ? 4 : 0) + ((f.width || 0) <= 640 ? 2 : 0) + (f.hasAudio !== false ? 1 : 0);
      if (!best || score > best.score)
        best = { url: f.url, mime: (f.mimeType || "").split(";")[0], score: score };
    }
    if (!best) return null;
    var out = { url: best.url, mime: best.mime };
    var secs = Number((sd && sd.expiresInSeconds) || 0);
    if (secs > 0) out.expireAt = Date.now() + secs * 1000;
    return out;
  }

  /**
   * One player request, two answers: the signed English caption URL, and what
   * YouTube says about the video itself. A clip that comes back LOGIN_REQUIRED
   * or UNPLAYABLE refuses to play inside any embed — no referrer trick fixes
   * that — and the card has to know *before* it starts the player.
   */
  async function fetchPlayerInfo(videoId) {
    var out = { track: null, playable: null, playReason: "", stream: null };
    var res = await withTimeout(
      fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=" + YT_ANDROID.key, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": "3",
          "x-youtube-client-version": YT_ANDROID.version
        },
        body: JSON.stringify({
          videoId: videoId,
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: YT_ANDROID.version,
              androidSdkVersion: YT_ANDROID.sdk,
              hl: "en",
              gl: "US"
            }
          },
          contentCheckOk: true,
          racyCheckOk: true
        })
      }),
      12000
    );
    if (!res.ok) return out;
    var j = await res.json();
    /* can this video be played at all — and if not, why? */
    var st = (j && j.playabilityStatus) || {};
    if (st.status) {
      out.playable = st.status === "OK";
      if (st.status !== "OK") out.playReason = st.reason || st.status;
    }
    /* the same answer hands over complete video URLs — the clip can then be
       played straight from them, with no embed and no referrer at all */
    out.stream = pickStream(j && j.streamingData);
    var tracks =
      (j &&
        j.captions &&
        j.captions.playerCaptionsTracklistRenderer &&
        j.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    if (!tracks.length) return out;
    var en = tracks.filter(function (t) {
      return t && /^en\b/i.test(t.languageCode || "");
    });
    var pick =
      en.filter(function (t) {
        return t.kind !== "asr";
      })[0] ||
      en[0] ||
      null;
    out.track = pick && pick.baseUrl ? pick : null;
    return out;
  }

  function decodeXml(s) {
    return String(s || "")
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) {
        return String.fromCharCode(parseInt(n, 16) || 0);
      })
      .replace(/&#(\d+);/g, function (_, n) {
        return String.fromCharCode(parseInt(n, 10) || 0);
      })
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }

  /**
   * Caption XML → cues. srv3 carries an offset for every single word, so each
   * word becomes its own cue: the player then starts on the exact word rather
   * than somewhere in the sentence.
   */
  function parseCaptionXml(xml) {
    var src = String(xml || "");
    var out = [];
    var line = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    var lm;
    while ((lm = line.exec(src))) {
      var head = lm[1] || "";
      /* drop self-closing slots first, or they'd swallow the next word */
      var inner = String(lm[2] || "")
        .replace(/<s\b[^>]*\/>/g, " ")
        .replace(/<w\b[^>]*\/>/g, " ");
      var t0 = parseFloat((head.match(/\bt="([0-9.]+)"/) || [])[1]);
      if (!isFinite(t0)) t0 = 0;
      var dur = parseFloat((head.match(/\bd="([0-9.]+)"/) || [])[1]);

      var words = [];
      var wrd = /<s\b([^>]*)>([\s\S]*?)<\/s>/g;
      var wm;
      while ((wm = wrd.exec(inner))) {
        var text = decodeXml(wm[2]).replace(/\s+/g, " ").trim();
        if (!text) continue;
        var off = (wm[1].match(/\bt="([0-9.]+)"/) || [])[1];
        words.push({ text: text, off: off === undefined ? null : parseFloat(off) });
      }
      if (!words.length) {
        var plain = decodeXml(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
        if (plain) words.push({ text: plain, off: null });
      }
      if (!words.length) continue;

      /* the first word always comes without an offset — fill the gaps in */
      var prev = 0;
      for (var i = 0; i < words.length; i++) {
        if (words[i].off === null || !isFinite(words[i].off)) words[i].off = prev;
        prev = words[i].off;
      }

      /* bounds of the whole caption line: the window plays the sentence the
         word sits in, not just the word itself */
      var lineNo = out.length ? out[out.length - 1].line + 1 : 0;
      var lineStart = t0 / 1000;
      var lineEnd = isFinite(dur) && dur > 0 ? (t0 + dur) / 1000 : (t0 + words[words.length - 1].off) / 1000 + 0.5;

      for (var k = 0; k < words.length; k++) {
        var start = (t0 + words[k].off) / 1000;
        var next =
          k + 1 < words.length ? words[k + 1].off : isFinite(dur) ? dur : words[k].off + 500;
        var end = (t0 + next) / 1000;
        if (end <= start) end = start + 0.4;
        out.push({
          start: start,
          end: end,
          text: words[k].text,
          line: lineNo,
          lineStart: lineStart,
          lineEnd: Math.max(lineEnd, end)
        });
      }
    }

    /* older/other tracks come back as plain <text start="1.2" dur="3.4"> */
    if (!out.length && src.indexOf("<text") > -1) {
      var tx = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
      var tm;
      while ((tm = tx.exec(src))) {
        var s0 = parseFloat((tm[1].match(/\bstart="([0-9.]+)"/) || [])[1]);
        var d0 = parseFloat((tm[1].match(/\bdur="([0-9.]+)"/) || [])[1]);
        if (!isFinite(s0)) continue;
        var body = decodeXml(tm[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
        if (!body) continue;
        out.push({ start: s0, end: isFinite(d0) ? s0 + d0 : s0 + 2, text: body });
      }
    }
    return out;
  }

  /* ------------------------------------------------------- caption bridge */
  /*
   * The card page can't ask YouTube for captions itself: the browser stamps
   * every request it makes with `Origin: chrome-extension://…`, which YouTube
   * answers with a 403. A request from a page sitting on youtube.com is fine,
   * so the app keeps one tiny hidden youtube.com frame open (robots.txt may
   * be framed) and asks bridge.js over there to do the fetching.
   */
  var YT_ORIGIN = "https://www.youtube.com";
  var bridgeFrame = null;
  var bridgeId = 0;

  function hasDom() {
    return typeof document !== "undefined" && typeof window !== "undefined" && !!document.createElement;
  }

  function bridgeFrameEl() {
    if (bridgeFrame && bridgeFrame.contentWindow) return bridgeFrame;
    var f = document.createElement("iframe");
    f.src = YT_ORIGIN + "/robots.txt";
    f.setAttribute("hidden", "");
    f.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).appendChild(f);
    bridgeFrame = f;
    return f;
  }

  /** Caption XML for the clip, straight from the hidden youtube.com frame. */
  function captionsViaBridge(videoId) {
    return new Promise(function (resolve) {
      var frame;
      try {
        frame = bridgeFrameEl();
      } catch (e) {
        resolve(null);
        return;
      }
      var id = ++bridgeId;
      var timer = null;
      var ticker = null;
      var finish = function (v) {
        if (timer) clearTimeout(timer);
        if (ticker) clearInterval(ticker);
        window.removeEventListener("message", onMsg);
        resolve(v);
      };
      var onMsg = function (ev) {
        var d = ev.data;
        if (ev.origin !== YT_ORIGIN) return;
        if (!d || d.fc !== 1 || d.type !== "fc:clip-captions" || d.id !== id) return;
        finish(d.moment);
      };
      window.addEventListener("message", onMsg);
      timer = setTimeout(function () {
        finish(null);
      }, 15000);

      var send = function () {
        if (!frame.contentWindow) return;
        try {
          frame.contentWindow.postMessage(
            { fc: 1, type: "fc:clip-captions", id: id, videoId: videoId },
            YT_ORIGIN
          );
        } catch (e) {
          finish(null);
        }
      };
      /* the frame is still loading at first — keep asking until it answers */
      var tries = 0;
      send();
      ticker = setInterval(function () {
        if (++tries > 10) {
          clearInterval(ticker);
          ticker = null;
          return;
        }
        send();
      }, 500);
    });
  }

  /** Caption XML for a clip, or { found: false, reason } for why not.
   *  Also carries `embeddable` (boolean | null) when YouTube answered it. */
  async function clipCaptions(videoId) {
    if (hasDom()) {
      var bridged = await captionsViaBridge(videoId);
      if (bridged) return bridged;
    }
    /* fallback: ask YouTube directly — works wherever no Origin is attached */
    var info;
    try {
      info = await fetchPlayerInfo(videoId);
    } catch (e) {
      return { found: false, reason: "unavailable" };
    }
    /* playable/playReason/stream travel with every answer: a video YouTube
       refuses to serve (bot-check, region, …) has no captions either, and the
       card must not confuse that with a clip that simply has none */
    var flags = {
      playable: info.playable,
      playReason: info.playReason,
      stream: info.stream || null
    };
    if (!info.track)
      return Object.assign(
        { found: false, reason: info.playable === false ? "unplayable" : "no-captions" },
        flags
      );
    var track = info.track;
    var url = track.baseUrl + (/[?&]fmt=/.test(track.baseUrl) ? "" : "&fmt=srv3");
    try {
      var res = await withTimeout(fetch(url), 10000);
      if (!res.ok) return Object.assign({ found: false, reason: "unavailable" }, flags);
      var body = await res.text();
      return body && body.charAt(0) === "<"
        ? Object.assign({ found: true, xml: body }, flags)
        : Object.assign({ found: false, reason: "empty-captions" }, flags);
    } catch (e) {
      return Object.assign({ found: false, reason: "unavailable" }, flags);
    }
  }

  /**
   * One attempt: get the clip's captions, find the word in them and return
   * the start/end of the sentence containing it — this is what lets the card
   * play only that moment instead of the whole video.
   * Returns { found, start, end, reason } plus, when YouTube said so,
   * `embeddable`, `playable` and `playReason`.
   */
  async function clipMomentOnce(videoId, query) {
    var miss = function (reason) {
      return { found: false, start: 0, end: 0, reason: reason };
    };
    if (!videoId || !cleanDisplay(query)) return miss("unavailable");

    var got = await clipCaptions(videoId);
    /* how far did YouTube let us get: may the clip be embedded at all, may it
       be played at all, and if not, what did it say? */
    var withFlag = function (o) {
      if (got && typeof got.embeddable === "boolean") o.embeddable = got.embeddable;
      if (got && typeof got.playable === "boolean") o.playable = got.playable;
      if (got && got.playReason) o.playReason = got.playReason;
      /* the same answer carried a playable video URL — the card can then
         play the moment from it directly, with no embed at all */
      if (got && got.stream) o.stream = got.stream;
      return o;
    };

    if (!got || !got.found) return withFlag(miss((got && got.reason) || "unavailable"));
    if (!got.xml || got.xml.charAt(0) !== "<") return withFlag(miss("empty-captions"));

    var cues = parseCaptionXml(got.xml);
    if (!cues.length) return withFlag(miss("empty-captions"));

    var m = findMoment(cues, query);
    if (!m) return withFlag(miss("word-not-in-captions"));
    return withFlag({ found: true, start: m.start, end: m.end, reason: "" });
  }

  /**
   * When exactly is this word said in the clip? Wraps the attempt above and
   * retries once — these requests are read over the network from a click, and
   * a dropped connection shouldn't cost the user the whole feature.
   * Returns { found, start, end, reason }.
   */
  async function fetchClipMoment(videoId, query) {
    var out;
    try {
      out = await clipMomentOnce(videoId, query);
    } catch (e) {
      out = { found: false, start: 0, end: 0, reason: "unavailable" };
    }
    if (out.reason !== "unavailable") return out;
    try {
      return await clipMomentOnce(videoId, query);
    } catch (e) {
      return out;
    }
  }

  /** Inline-player URL for a clip, starting (and stopping) at that moment. */
  function embedUrl(videoId, start, end) {
    var u =
      "https://www.youtube.com/embed/" +
      encodeURIComponent(videoId) +
      "?rel=0&modestbranding=1&playsinline=1&autoplay=1";
    var s = Math.max(0, Math.floor(Number(start) || 0));
    var e = Math.ceil(Number(end) || 0);
    if (s > 0) u += "&start=" + s;
    if (e > s) u += "&end=" + e;
    return u;
  }

  /**
   * Where is this word said in films, series and cartoons? Searches YouTube
   * (the phrase first, when the card has one) and returns clip-length hits.
   * Result is cached on the card, so each word is searched only once.
   */
  async function fetchClips(word, phrase) {
    var w = cleanDisplay(word);
    if (!w) return { query: "", items: [] };
    var queries = [];
    if (phrase && phrase.toLowerCase() !== w.toLowerCase()) queries.push('"' + phrase + '"');
    queries.push(w + " scene");
    queries.push('"' + w + '"');

    var items = [];
    var used = "";
    for (var i = 0; i < queries.length && items.length < 5; i++) {
      var url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(queries[i]);
      try {
        var res = await withTimeout(
          fetch(url, { headers: { "accept-language": "en-US,en;q=0.9" } }),
          10000
        );
        if (!res.ok) continue;
        var got = parseYouTubeSearch(await res.text());
        if (got.length && !used) used = queries[i];
        for (var j = 0; j < got.length && items.length < 8; j++) {
          (function (c) {
            if (
              !items.some(function (x) {
                return x.id === c.id;
              })
            )
              items.push(c);
          })(got[j]);
        }
      } catch (e) {
        /* try the next query */
      }
    }
    return { query: used, items: items };
  }

  /** Plain-English text -> Persian / Arabic / … (Google Translate, no key). */
  async function translateText(text, to) {
    var t = String(text || "").trim();
    if (!t || !to || to === "en") return t;
    var url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=" +
      encodeURIComponent(to) +
      "&dt=t&q=" +
      encodeURIComponent(t);
    var res = await withTimeout(fetch(url), 8000);
    if (!res.ok) throw new Error("translate " + res.status);
    var json = await res.json();
    var segs = (json && json[0]) || [];
    var out = "";
    for (var i = 0; i < segs.length; i++) if (segs[i] && segs[i][0]) out += segs[i][0];
    return out.trim();
  }

  /** Translate, falling back to the background worker if the page fetch is blocked. */
  async function translate(text, to) {
    try {
      return await translateText(text, to);
    } catch (e) {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
        return await new Promise(function (resolve, reject) {
          chrome.runtime.sendMessage({ type: "fc:translate", text: text, to: to }, function (r) {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!r || r.error) reject(new Error((r && r.error) || "translate failed"));
            else resolve(r.text);
          });
        });
      }
      throw e;
    }
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error("timeout"));
      }, ms || 7000);
      promise.then(
        function (v) {
          clearTimeout(t);
          resolve(v);
        },
        function (e) {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  /** Meaning and sentence in ONE request — half the round trips per language.
      gtx keeps the lines apart, so the answer splits back in two. */
  async function translateBoth(meaning, sentence, to) {
    var m = String(meaning || "").trim();
    var s = String(sentence || "").trim();
    if (!m && !s) return { meaning: "", sentence: "" };
    if (!m) return { meaning: "", sentence: (await translate(s, to)) || "" };
    if (!s) return { meaning: (await translate(m, to)) || "", sentence: "" };
    try {
      var both = await translateText(m + "\n" + s, to);
      var nl = both.indexOf("\n");
      if (nl > -1)
        return { meaning: both.slice(0, nl).trim(), sentence: both.slice(nl + 1).trim() };
    } catch (e) {
      /* the endpoint merged the lines — fall back to two calls below */
    }
    return {
      meaning: await translate(m, to).catch(function () {
        return "";
      }),
      sentence: await translate(s, to).catch(function () {
        return "";
      })
    };
  }

  var trChains = typeof WeakMap === "function" ? new WeakMap() : null;

  /**
   * Meaning + clicked sentence in the user's chosen languages — everything
   * the mini card on YouTube needs to be readable without English. Fills
   * `card.translations` (meaning) and `card.contextTr` (sentence) and saves
   * the card. Safe to call again while a run is going: runs queue on the
   * card and each one fills only what is still missing.
   */
  async function loadTranslations(card) {
    if (!card) return card;
    var run = function () {
      return runTranslations(card);
    };
    if (!trChains) return run();
    var prev = trChains.get(card) || Promise.resolve();
    var next = prev.then(run, run);
    trChains.set(card, next);
    return next;
  }

  async function runTranslations(card) {
    var settings = await getSettings();
    var langs = settings.trLangs || [];
    var meaning = simpleExplain(card.meaning || "");
    var sentence = card.context || "";
    card.translations = card.translations || {};
    card.contextTr = card.contextTr || {};
    if (!langs.length) return card;

    var thunks = [];
    langs.forEach(function (to) {
      var needM = meaning && !card.translations[to];
      var needS = sentence && !card.contextTr[to];
      if (!needM && !needS) return;
      /* one request per language: meaning and sentence travel together */
      thunks.push(function () {
        return translateBoth(needM ? meaning : "", needS ? sentence : "", to).then(
          function (r) {
            if (!r) return;
            if (r.meaning && !card.translations[to]) card.translations[to] = r.meaning;
            if (r.sentence && !card.contextTr[to]) card.contextTr[to] = r.sentence;
          }
        );
      });
    });
    if (!thunks.length) return card;

    for (var i = 0; i < thunks.length; i++) {
      try {
        await thunks[i]();
      } catch (e) {
        /* one language failed — the rest may still land */
      }
      if (i < thunks.length - 1)
        await new Promise(function (r) {
          setTimeout(r, 160);
        });
    }
    try {
      await saveCard(card);
    } catch (e) {
      /* translations are still shown for this session */
    }
    return card;
  }

  async function fetchWiktionary(word, lang, context) {
    var url =
      "https://" +
      (lang || "en") +
      ".wiktionary.org/api/rest_v1/page/definition/" +
      encodeURIComponent(word);
    var res = await withTimeout(fetch(url, { headers: { accept: "application/json" } }));
    if (!res.ok) throw new Error("wiktionary " + res.status);
    var json = await res.json();
    var want = (lang || "en").toLowerCase();
    var defs = [];
    var seen = {};
    var wikiExample = "";

    Object.keys(json).forEach(function (groupKey) {
      var groups = json[groupKey] || [];
      groups.forEach(function (g) {
        /* Only the language we asked for — the endpoint also returns every
           other language the word appears in (and Translingual symbols). */
        if (want === "en" && String(g.language || "").toLowerCase() !== "english") return;
        else if (want !== "en" && g.language && String(g.language).toLowerCase() !== want) return;

        (g.definitions || []).forEach(function (d) {
          if (!wikiExample && d.examples && d.examples.length) {
            var ex = stripHtml(d.examples[0]);
            if (ex) wikiExample = ex;
          }
          if (defs.length >= 6) return;
          var text = stripHtml(d.definition);
          if (!text) return;
          var key = (g.partOfSpeech || "") + "|" + text;
          if (seen[key]) return;
          seen[key] = 1;
          defs.push({ pos: g.partOfSpeech || "", text: text });
        });
      });
    });

    if (!defs.length) return null;
    var out = pack(defs, "wiktionary", context, word);
    out.example = wikiExample;
    return out;
  }

  async function fetchDictionaryApi(word, lang, context) {
    var url =
      "https://api.dictionaryapi.dev/api/v2/entries/" +
      encodeURIComponent(lang || "en") +
      "/" +
      encodeURIComponent(word);
    var res = await withTimeout(fetch(url));
    if (!res.ok) throw new Error("dictionaryapi " + res.status);
    var json = await res.json();
    var defs = [];
    (Array.isArray(json) ? json : []).forEach(function (entry) {
      /* Guard: never accept an entry filed under a different headword. */
      if (entry.word && !sameWord(entry.word, word)) return;
      (entry.meanings || []).forEach(function (m) {
        (m.definitions || []).forEach(function (d) {
          if (defs.length >= 6) return;
          var text = d.definition ? stripHtml(d.definition) : "";
          if (!text) return;
          defs.push({ pos: m.partOfSpeech || "", text: text });
        });
      });
    });
    return defs.length ? pack(defs, "dictionaryapi", context, word) : null;
  }

  function pack(defs, source, context, word) {
    var ordered = rankDefs(defs, context, word);
    var first = ordered[0];
    /* Plain, clean one-liner — the study card adds the part-of-speech chip. */
    var meaning = first.text || "";
    if (meaning.length > 220) meaning = meaning.slice(0, 217).trim() + "…";
    return { definitions: ordered, meaning: meaning, source: source };
  }

  /* ------------------------------------------------------------ sense rank */
  /* "Liver" in a sentence about the body is not "a resident of Liverpool" —
     the dictionary lists every sense, and the clicked sentence is the only
     evidence of which one is meant. So every sense is scored against the
     whole sentence before one becomes the card's meaning. */

  var RANK_STOP =
    "a an the and or but if then else of to in on at for with from by as is are was were be been being " +
    "i you he she it we they me him her us them my your his its our their this that these those there here " +
    "so not no yes do does did done have has had will would can could should may might must let s dont cant " +
    "am what which who whom when where why how all any some more most other into over under about after " +
    "before up down out off just very much many one two too also im ive ill youve youll theyre theres " +
    "gonna wanna gonna kinda yeah okay ok oh uh um er ah hm";
  var RANK_STOP_MAP = Object.create(null);
  RANK_STOP.split(" ").forEach(function (w) {
    RANK_STOP_MAP[w] = 1;
  });

  /** Words of the sentence worth matching against a definition. */
  function rankContextWords(context, word) {
    var self = String(word || "").toLowerCase();
    var out = [];
    var seen = Object.create(null);
    tokenize(String(context || "").toLowerCase()).forEach(function (t) {
      var w = t.replace(/^['’]+|['’]+$/g, "");
      if (w.length < 4) return;
      if (RANK_STOP_MAP[w]) return;
      if (self && (w === self || w.replace(/(ing|ed|es|s)$/, "") === self)) return;
      var stem = w.replace(/(ing|ed|es|s)$/, "");
      var key = stem.length >= 4 ? stem : w;
      if (seen[key]) return;
      seen[key] = 1;
      out.push(key);
    });
    return out;
  }

  /** Guess the clicked word's job in this sentence: a noun, a verb, or "". */
  function posCue(context, word) {
    var toks = tokenize(String(context || ""));
    var target = String(word || "").toLowerCase();
    var idx = -1;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].toLowerCase().replace(/^['’]+|['’]+$/g, "") === target) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return "";
    var prev = idx > 0 ? toks[idx - 1].toLowerCase() : "";
    var next = idx + 1 < toks.length ? toks[idx + 1].toLowerCase() : "";
    var nounBefore = { a: 1, an: 1, the: 1, my: 1, your: 1, his: 1, her: 1, its: 1, our: 1, their: 1, some: 1, this: 1, that: 1, these: 1, those: 1, one: 1, any: 1, no: 1, every: 1, each: 1, another: 1, new: 1, bad: 1, good: 1, whole: 1, main: 1 };
    var verbBefore = { to: 1, will: 1, would: 1, can: 1, could: 1, should: 1, must: 1, please: 1, let: 1, dont: 1, never: 1, always: 1 };
    var nounAfter = { is: 1, are: 1, was: 1, were: 1, has: 1, have: 1, had: 1, feels: 1, hurt: 1, hurts: 1, hurting: 1, working: 1, failing: 1, shutting: 1, killing: 1, waiting: 1 };
    if (nounBefore[prev]) return "noun";
    if (verbBefore[prev]) return "verb";
    if (nounAfter[next]) return "noun";
    return "";
  }

  /** Does the sentence use a proper name anywhere (besides its first word)? */
  function sentenceHasProper(context) {
    var toks = tokenize(String(context || ""));
    for (var i = 1; i < toks.length; i++) {
      if (/^[A-Z][a-z]{2,}/.test(toks[i])) return true;
    }
    return false;
  }

  /** One sense, scored against the sentence it was clicked in. */
  function senseScore(def, context, word, order) {
    var text = String(def.text || "");
    var pos = String(def.pos || "").toLowerCase();
    /* dictionaries order senses by frequency — a quiet prior toward the top */
    var score = 10 - order;

    /* words of the sentence appearing in the definition's own words */
    var hay = " " + text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ") + " ";
    var ctxWords = rankContextWords(context, word);
    for (var i = 0; i < ctxWords.length; i++) {
      if (hay.indexOf(" " + ctxWords[i]) > -1 || hay.indexOf(" " + ctxWords[i] + "s") > -1) score += 4;
    }

    /* a sense that names a place/person (Liverpool…) is not what a plain
       lowercase sentence is talking about */
    var namesPlace = /\b[A-Z][a-z]{2,}\b/.test(text.replace(/^\s*[A-Z][a-z]{0,2}\b/, " "));
    if (namesPlace && !sentenceHasProper(context)) score -= 12;

    /* dialect / register markers only fit when the sentence shows the same */
    if (/\b(chiefly|slang|dialect|archaic|dated|humorous|informal)\b/i.test(text) && !/\b(chiefly|slang|mate|gonna|wanna|ain|dunno|kinda|sorta)\b/i.test(String(context || "")))
      score -= 3;

    /* the sentence's grammar: "my … hurting" wants a noun, "to …" a verb */
    var cue = posCue(context, word);
    if (cue) {
      if (pos.indexOf(cue) > -1) score += 6;
      else if (pos) score -= 3;
    }
    return score;
  }

  /** All senses, best fit for this sentence first. */
  function rankDefs(defs, context, word) {
    var list = (defs || []).slice();
    if (!context || list.length < 2) return list;
    return list
      .map(function (def, i) {
        return { def: def, i: i, score: senseScore(def, context, word, i) };
      })
      .sort(function (a, b) {
        return b.score - a.score || a.i - b.i;
      })
      .map(function (r) {
        return r.def;
      });
  }

  /* --------------------------------------------------------- phrases/idioms */
  function tokenize(s) {
    try {
      return String(s || "").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
    } catch (e) {
      return String(s || "").match(/[A-Za-z0-9]+/g) || [];
    }
  }

  /**
   * Word-windows around `word` inside its punctuation-bounded clause, longest
   * and most centred first. For "act" in "…, get your act together, …" this
   * yields ["get your act together", "your act together", "act together"].
   */
  function phraseCandidates(context, word) {
    var text = String(context || "");
    var target = normalize(word);
    if (!text || !target) return [];

    var clauses = text.split(/[.,;:!?…()"\u201c\u201d\u2018\u2019[\]\u2014\u2013]+/);
    var tokens = null;
    for (var c = 0; c < clauses.length; c++) {
      var t = tokenize(clauses[c]);
      if (
        t.some(function (tok) {
          return normalize(tok) === target;
        })
      ) {
        tokens = t;
        break;
      }
    }
    if (!tokens || tokens.length < 2) return [];

    var hits = [];
    for (var i = 0; i < tokens.length; i++) if (normalize(tokens[i]) === target) hits.push(i);
    if (!hits.length) return [];

    var out = [];
    var lens = [4, 3, 5, 2, 6];
    for (var l = 0; l < lens.length; l++) {
      var len = lens[l];
      if (len > tokens.length) continue;
      for (var h = 0; h < hits.length; h++) {
        var idx = hits[h];
        var starts = [];
        for (var s = Math.max(0, idx - len + 1); s <= Math.min(idx, tokens.length - len); s++)
          starts.push(s);
        starts.sort(function (a, b) {
          return Math.abs(idx - a - (len - 1) / 2) - Math.abs(idx - b - (len - 1) / 2);
        });
        for (var k = 0; k < starts.length; k++)
          out.push(tokens.slice(starts[k], starts[k] + len).join(" "));
      }
    }

    var seen = {};
    var res = [];
    for (var n = 0; n < out.length; n++) {
      var key = out[n].toLowerCase();
      if (seen[key]) continue;
      seen[key] = 1;
      if (normalize(out[n]) === target) continue; // never the bare word
      res.push(out[n]);
      if (res.length >= 4) break;
    }
    return res;
  }

  /** Definitions for a literal expression — no example/phrase recursion. */
  async function lookupDefs(word, lang, context) {
    var sources = [fetchWiktionary, fetchDictionaryApi];
    /* Dictionaries file "Liver" (the Liverpool adjective) and "liver" (the
       organ) as different entries, and subtitles capitalize the first word
       of every sentence — so a single word is looked up in its lowercase
       form first, and the clicked form only if that finds nothing. Proper
       nouns are safe: the lowercase page either redirects to them or 404s
       into the fallback. */
    var forms = [String(word || "")];
    if (/^[A-Za-z]+$/.test(forms[0]) && forms[0] !== forms[0].toLowerCase())
      forms = [forms[0].toLowerCase(), forms[0]];

    for (var f = 0; f < forms.length; f++) {
      for (var i = 0; i < sources.length; i++) {
        try {
          var r = await sources[i](forms[f], lang, context);
          if (r && r.meaning) return r;
        } catch (e) {
          /* try next source */
        }
      }
    }
    return null;
  }

  /**
   * Is the clicked word part of an idiom/phrase in this sentence? Wiktionary
   * redirects "get your act together" to "get one's act together", so the
   * words as spoken match the dictionary entry.
   */
  async function fetchPhrase(context, word, lang) {
    var cands = phraseCandidates(context, word);
    for (var i = 0; i < cands.length; i++) {
      var phrase = cands[i];
      try {
        var r = await lookupDefs(phrase, lang);
        if (r) {
          return {
            text: phrase,
            meaning: r.meaning,
            definitions: (r.definitions || []).slice(0, 4),
            example: r.example || "",
            source: r.source
          };
        }
      } catch (e) {
        /* next candidate */
      }
    }
    return null;
  }

  /** Example sentences + the idiom/phrase this sentence uses, fetched
      together — the two things that used to make the popup wait. */
  async function fetchExtras(word, context, lang) {
    var out = { examples: [], example: "", phrase: null };
    var w = cleanDisplay(word);
    if (!w) return out;
    var jobs = [
      fetchExamples(w, 4)
        .then(function (list) {
          out.examples = list || [];
        })
        .catch(function () {})
    ];
    if (context)
      jobs.push(
        fetchPhrase(context, w, lang || "en")
          .then(function (p) {
            out.phrase = p;
          })
          .catch(function () {})
      );
    await Promise.all(jobs);
    return out;
  }

  /**
   * Raw lookup (used by the background worker and by pages without messaging).
   * mode "fast" = the definition only — one request, what the mini popup
   * shows first. mode "extras" = example sentences + idiom phrase only. The
   * full path runs the dictionary, Tatoeba and the phrase candidates in
   * parallel, so nothing queues up behind the slowest source.
   */
  async function fetchMeaning(word, lang, context, mode) {
    var none = { definitions: [], meaning: "", example: "", phrase: null, source: "none" };
    var w = cleanDisplay(word);
    if (!w) return none;

    if (mode === "fast") {
      var f = await lookupDefs(w, lang, context);
      var fast = f || { definitions: [], meaning: "", example: "", source: "none" };
      fast.examples = null;
      fast.phrase = null;
      return fast;
    }

    if (mode === "extras") {
      var ex = await fetchExtras(w, context, lang);
      return {
        definitions: [],
        meaning: "",
        example: ex.examples.length ? ex.examples[0] : "",
        phrase: ex.phrase,
        examples: ex.examples,
        source: "extras"
      };
    }

    /* kicked before the dictionary is awaited — they finish together */
    var extrasP = fetchExtras(w, context, lang);

    var out = (await lookupDefs(w, lang, context)) || {
      definitions: [],
      meaning: "",
      example: "",
      source: "none"
    };
    var wikiExample = out.example || "";

    var extras = await extrasP;
    var sentences = extras.examples.slice();
    if (!sentences.length && wikiExample) sentences = [wikiExample];
    out.examples = sentences;
    out.example = sentences.length ? sentences[0] : wikiExample;
    out.phrase = extras.phrase;

    if (out.source === "none" && !out.phrase) return none;
    return out;
  }

  /** Meaning lookup that prefers the background worker (no CORS worries).
      mode "fast" = definition only; "extras" = sentences + phrase only. */
  async function lookupMeaning(word, lang, context, mode) {
    var m = mode || "full";
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
      try {
        var res = await new Promise(function (resolve, reject) {
          chrome.runtime.sendMessage(
            { type: "fc:lookup", word: word, lang: lang, context: context, mode: m },
            function (r) {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(r);
            }
          );
        });
        if (res && res.ok && res.meaning != null) return res.meaning;
      } catch (e) {
        /* fall through to a direct request */
      }
    }
    return fetchMeaning(word, lang, context, m);
  }

  /* ------------------------------------------------------------------ stats */
  function deckSummary(cards, settings, stats, now) {
    now = now || Date.now();
    stats = Object.assign({}, DEFAULT_STATS, stats || {});
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var queue = buildQueue(cards, settings, stats, now);
    var fresh = queue.filter(function (c) {
      return c.status === "new";
    }).length;
    var next = cards
      .filter(function (c) {
        return c.srs.due > now;
      })
      .sort(function (a, b) {
        return a.srs.due - b.srs.due;
      })[0];
    return {
      total: cards.length,
      due: queue.length,
      dueReviews: queue.length - fresh,
      dueNew: fresh,
      mastered: cards.filter(function (c) {
        return c.status === "mastered";
      }).length,
      learning: cards.filter(function (c) {
        return c.status === "learning";
      }).length,
      streak: stats.streak || 0,
      reviewsToday: stats.reviewsDay === dayKey(now) ? stats.reviewsToday || 0 : 0,
      totalReviews: stats.totalReviews || 0,
      nextDueIn: next ? next.srs.due - now : null,
      nextDueLabel: next ? fmtMs(next.srs.due - now) : ""
    };
  }

  /* ----------------------------------------------------------------- export */
  root.FC = {
    version: 1,
    hasExtensionStorage: HAS_EXT_STORAGE,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_STATS: DEFAULT_STATS,
    GRADES: GRADES,
    store: { get: storeGet, set: storeSet, remove: storeRemove, onChange: onChange },

    normalize: normalize,
    cleanDisplay: cleanDisplay,
    cleanText: stripHtml,
    simpleExplain: simpleExplain,
    fetchExample: fetchExample,
    fetchExamples: fetchExamples,
    fetchPronunciation: fetchPronunciation,
    parseYouTubeSearch: parseYouTubeSearch,
    fetchClips: fetchClips,
    fetchClipMoment: fetchClipMoment,
    clipCaptions: clipCaptions,
    fetchCaptionTrack: fetchCaptionTrack,
    parseCaptionXml: parseCaptionXml,
    findMoment: findMoment,
    embedUrl: embedUrl,
    extractJsonObject: extractJsonObject,
    phraseCandidates: phraseCandidates,
    fetchPhrase: fetchPhrase,
    translate: translate,
    translateText: translateText,
    translateBoth: translateBoth,
    cardKey: cardKey,

    LANGS: LANGS,
    LANG_MAP: LANG_MAP,
    langName: langName,
    sanitizeTrLangs: sanitizeTrLangs,

    listCards: listCards,
    getCard: getCard,
    saveCard: saveCard,
    deleteCard: deleteCard,
    importCards: importCards,
    resetAll: resetAll,
    createCard: createCard,

    getSettings: getSettings,
    saveSettings: saveSettings,
    getStats: getStats,
    saveStats: saveStats,

    schedule: schedule,
    gradeLabel: gradeLabel,
    recordReview: recordReview,
    buildQueue: buildQueue,
    statusLabel: statusLabel,
    dueLabel: dueLabel,
    deckSummary: deckSummary,

    lookupMeaning: lookupMeaning,
    fetchMeaning: fetchMeaning,
    fetchExtras: fetchExtras,
    loadTranslations: loadTranslations,
    rankDefs: rankDefs,
    stripHtml: stripHtml,

    startOfDay: startOfDay,
    dayKey: dayKey,
    isSameDay: isSameDay,
    fmtMs: fmtMs,
    fmtInterval: fmtInterval
  };
})(typeof self !== "undefined" ? self : this);
