/* =============================================================================
 * FluentCards — flashcard app (study, library, settings)
 * ========================================================================== */
(function () {
  "use strict";

  if (typeof FC === "undefined") {
    document.body.innerHTML =
      '<p style="padding:40px;font-family:sans-serif">storage.js failed to load.</p>';
    return;
  }

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var state = {
    view: "today",
    cards: [],
    settings: {},
    stats: {},
    queue: [],
    idx: 0,
    revealed: false,
    summary: null, // {count} shown after finishing a session
    search: "",
    filter: "all",
    lookupBusy: false,
    explain: "en", // explanation language currently shown on the card
    explainFor: "", // norm of the card `explain` belongs to
    addText: "" // text shared from another app, waiting on the Add view
  };

  /* Running as the hosted web app (not inside the extension)? storage.js
     already falls back to localStorage here; this flag lets the UI skip the
     things a web page genuinely cannot do — inline clip playback (needs the
     extension's YouTube bridge) and the caption-clicking feature. */
  var IS_WEB =
    typeof location !== "undefined" &&
    (location.protocol === "https:" || location.protocol === "http:") &&
    !(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);

  var toastTimer = null;

  /* ------------------------------------------------------------------ boot */
  async function boot() {
    state.settings = await FC.getSettings();
    state.stats = await FC.getStats();
    applyTheme();
    await reloadCards(true);

    var hash = String(location.hash || "").replace("#", "");
    if (hash === "library" || hash === "settings" || hash === "today" || hash === "add") {
      state.view = hash;
    }

    /* text shared from another app (Android share target → app.html?text=…) */
    var shared = readShareText();
    if (shared) {
      state.view = "add";
      state.addText = shared;
    }

    bindStaticEvents();
    render();
    FC.store.onChange(function () {
      FC.getSettings().then(function (s) {
        state.settings = s;
        applyTheme();
        syncSettingsForm();
      });
      FC.getStats().then(function (s) {
        state.stats = s;
        renderStreak();
      });
      FC.listCards().then(function (cards) {
        state.cards = cards;
        if (!state.queue.length && !state.summary && state.view === "today") rebuildQueue();
        render();
      });
    });
  }

  async function reloadCards(rebuild) {
    state.cards = await FC.listCards();
    if (rebuild) rebuildQueue();
    pruneQueue();
  }

  function rebuildQueue() {
    state.summary = null;
    state.queue = FC.buildQueue(state.cards, state.settings, state.stats, Date.now());
    if (state.idx > state.queue.length) state.idx = 0;
    if (state.queue.length === 0) state.idx = 0;
  }

  /** Drops cards that no longer exist (deleted from the library). */
  function pruneQueue() {
    if (!state.queue.length) return;
    var known = Object.create(null);
    state.cards.forEach(function (c) {
      known[c.norm] = true;
    });
    state.queue = state.queue.filter(function (c) {
      return known[c.norm];
    });
    if (state.idx >= state.queue.length) {
      if (state.queue.length === 0) state.idx = 0;
      else state.idx = state.queue.length - 1;
    }
  }

  /* ---------------------------------------------------------------- render */
  function render() {
    renderStreak();
    $$(".nav-btn").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.view === state.view);
    });
    $$(".view").forEach(function (v) {
      v.classList.toggle("is-active", v.id === "view-" + state.view);
    });

    if (state.view === "today") renderToday();
    if (state.view === "add") renderAdd();
    if (state.view === "library") renderLibrary();
    if (state.view === "settings") syncSettingsForm();
  }

  function renderStreak() {
    var n = state.stats.streak || 0;
    $("#streakCount").textContent = n;
    $("#streakBadge").style.display = n > 0 ? "" : "none";
  }

  /* ------------------------------------------------------------------ ADD */
  /* Text another app shared to us (Android share target) — read once from
     the URL, then cleared so a refresh doesn't re-add. */
  function readShareText() {
    try {
      var p = new URLSearchParams(location.search);
      var t = p.get("text") || "";
      if (t && location.search.indexOf("text=") > -1) {
        history.replaceState(null, "", location.pathname + location.hash);
        return t;
      }
    } catch (e) {
      /* no share params */
    }
    return "";
  }

  /** A sentence (or a single word) → the words you can tap to save. */
  function tokenize(text) {
    var seen = Object.create(null);
    var out = [];
    var re = /[A-Za-zÀ-ÖØ-öø-ÿ'’-]+/g;
    var m;
    while ((m = re.exec(text))) {
      var raw = m[0].replace(/^['’-]+|['’-]+$/g, "");
      if (!raw) continue;
      var key = raw.toLowerCase();
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ word: raw, norm: FC.normalize(raw) });
    }
    return out;
  }

  function renderAdd() {
    var area = $("#addText");
    if (!area) return;

    /* text shared from the share sheet lands here */
    if (state.addText) {
      area.value = state.addText;
      state.addText = "";
      tokenizeInto(area.value);
    }

    var fb = $("#addFeedback");
    if (fb) {
      fb.hidden = !IS_WEB;
      fb.textContent = IS_WEB
        ? "Tip: on your phone, highlight text in any app → Share → FluentCards and it lands right here."
        : "";
    }
  }

  function tokenizeInto(text) {
    var host = $("#addTokens");
    var status = $("#addStatus");
    if (!host) return;
    host.innerHTML = "";
    if (status) {
      status.hidden = true;
      status.innerHTML = "";
    }

    var words = tokenize(text || "");
    if (!words.length) {
      if (status) {
        status.hidden = false;
        status.textContent = "Type or paste a sentence first.";
      }
      return;
    }

    words.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "add-token";
      b.textContent = t.word;
      b.setAttribute("data-norm", t.norm);
      var existing = state.cards.filter(function (c) {
        return c.norm === t.norm;
      })[0];
      if (existing) {
        b.classList.add("is-saved");
        b.title = "Already in your deck";
      }
      b.addEventListener("click", function () {
        saveAddWord(t.word, (area.value || "").trim(), b);
      });
      host.appendChild(b);
    });

    if (status) {
      status.hidden = false;
      status.innerHTML =
        "<b>" +
        words.length +
        "</b> word" +
        (words.length === 1 ? "" : "s") +
        " — tap the ones you want to learn.";
    }
  }

  /** Save one tapped word as a card, with the sentence as its context. */
  function saveAddWord(word, context, btn) {
    if (btn && btn.classList.contains("is-saved")) return;
    if (btn) btn.classList.add("is-saving");

    FC.createCard({ word: word, context: context })
      .then(function (res) {
        var card = res && res.card;
        if (!card) throw new Error("no card");

        /* mark it saved straight away — meaning can fill in after */
        if (btn) {
          btn.classList.remove("is-saving");
          btn.classList.add("is-saved");
          btn.title = "Saved";
        }
        state.cards.push(card);
        rebuildQueue();
        renderStreak();
        toast('Saved "' + card.word + '"');

        /* pull the meaning fast, then the chosen-language translation */
        return FC.lookupMeaning(card.word, state.settings.lang || "en", card.context, "fast")
          .then(function (m) {
            if (m && m.meaning) {
              card.meaning = m.meaning;
              card.definitions = m.definitions;
              card.meaningSource = m.source;
            }
            return FC.saveCard(card).catch(function () {});
          })
          .then(function () {
            return FC.lookupMeaning(card.word, state.settings.lang || "en", card.context, "extras")
              .then(function (x) {
                if (!x) return;
                if (x.phrase) card.phrase = x.phrase;
                if (x.examples && x.examples.length) {
                  card.examples = x.examples;
                  if (!card.example) card.example = x.examples[0];
                }
                return FC.saveCard(card).catch(function () {});
              })
              .catch(function () {});
          })
          .then(function () {
            return FC.loadTranslations(card).catch(function () {});
          })
          .then(function () {
            var live = liveCopy(card);
            if (live && live !== card) {
              live.meaning = card.meaning;
              live.definitions = card.definitions;
              live.translations = card.translations;
              live.contextTr = card.contextTr;
            }
          });
      })
      .catch(function () {
        if (btn) {
          btn.classList.remove("is-saving");
          btn.title = "Could not save";
        }
        toast("Could not save that word");
      });
  }

  /* --------------------------------------------------------------- TODAY */
  function renderToday() {
    var host = $("#todayBody");
    var sum = FC.deckSummary(state.cards, state.settings, state.stats, Date.now());
    pruneQueue();

    if (state.queue.length === 0 || state.idx >= state.queue.length) {
      state.idx = 0;
      host.innerHTML = emptyStateHtml(sum, !!state.summary);
      wireEmptyState(host);
      return;
    }

    var card = state.queue[state.idx];
    var done = state.idx;
    var total = state.queue.length;
    var pct = total ? Math.round((done / total) * 100) : 0;
    var later = total - done;

    host.innerHTML =
      '<div class="study-head">' +
      '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
      '<div class="study-count">' +
      done +
      " / " +
      total +
      (later ? " · " + later + " left" : "") +
      "</div></div>" +
      '<div class="card-stage">' +
      (state.revealed ? backHtml(card) : frontHtml(card)) +
      "</div>" +
      (state.revealed ? gradesHtml(card) : "");

    if (state.revealed) wireGrades(host);
    else wireFront(host);
  }

  function frontHtml(card) {
    return (
      '<article class="fcard fade-in"><div class="fc-split">' +
      '<div class="fc-main">' +
      '<div class="fcard-label">' +
      (card.status === "new" ? "New word" : "Review · " + esc(FC.statusLabel(card))) +
      "</div>" +
      '<div class="word-row"><h1 class="word">' +
      esc(card.word) +
      "</h1>" +
      '<button class="say-btn" data-act="say" title="Hear the word" aria-label="Hear the word">🔊</button>' +
      "</div>" +
      (card.context
        ? '<p class="word-context">What does it mean here?</p>' +
          '<div class="cloze" id="clozeLine"></div>'
        : '<p class="word-context">Click reveal to see the meaning.</p>') +
      '<div class="reveal-hint">' +
      '<button class="btn" data-act="reveal">Show meaning</button>' +
      "<span><kbd>Space</kbd> to flip</span>" +
      "</div></div>" +
      sideHtml(card, false) +
      "</div></article>"
    );
  }

  /** Duolingo-style cloze: the sentence with the word blanked out. */
  function clozeContext(text, word) {
    var frag = document.createDocumentFragment();
    text = String(text || "");
    var target = String(word || "").toLowerCase();
    if (!target) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    var lower = text.toLowerCase();
    var isWordChar = function (ch) {
      return ch ? /[\p{L}\p{N}]/u.test(ch) : false;
    };
    var i = 0;
    var idx;
    var found = false;
    while ((idx = lower.indexOf(target, i)) !== -1) {
      if (isWordChar(text[idx - 1]) || isWordChar(text[idx + target.length])) {
        i = idx + 1;
        continue;
      }
      frag.appendChild(document.createTextNode(text.slice(i, idx)));
      var blank = document.createElement("b");
      blank.className = "cloze-blank";
      blank.textContent = "______";
      frag.appendChild(blank);
      found = true;
      i = idx + target.length;
    }
    if (!found) frag.appendChild(document.createTextNode(text));
    else frag.appendChild(document.createTextNode(text.slice(i)));
    return frag;
  }

  function cleanText(s) {
    return typeof FC.cleanText === "function" ? FC.cleanText(s) : String(s || "");
  }

  /** The user's chosen translation languages (English is always there). */
  function trLangList() {
    var s = state.settings || {};
    var list = Array.isArray(s.trLangs)
      ? s.trLangs
      : (FC.DEFAULT_SETTINGS && FC.DEFAULT_SETTINGS.trLangs) || ["fa", "ar"];
    return list.filter(function (c) {
      return c && c !== "en";
    });
  }

  function langName(code) {
    return (FC.LANG_MAP && FC.LANG_MAP[code]) || code;
  }

  function backHtml(card) {
    var defs = (card.definitions || [])
      .map(function (d) {
        return { pos: d.pos || "", text: cleanText(d.text) };
      })
      .filter(function (d) {
        return d.text;
      });
    var meaning = cleanText(card.meaning);
    if (!meaning && defs.length) meaning = defs[0].text;
    /* Old cards stored a "noun: …" prefix — the chip now carries that. */
    var leadPos = defs.length && defs[0].pos ? defs[0].pos.toLowerCase() + ": " : "";
    if (leadPos && meaning.toLowerCase().indexOf(leadPos) === 0)
      meaning = meaning.slice(leadPos.length);

    /* One explanation language per card; a fresh card starts on the setting
       — as long as that language is still one of the chosen ones. */
    if (state.explainFor !== card.norm) {
      state.explainFor = card.norm;
      var pref = state.settings.explainIn || "en";
      state.explain = pref === "en" || trLangList().indexOf(pref) > -1 ? pref : "en";
    }
    var lang = state.explain || "en";
    var plain = simpleOf(meaning);
    var alt = lang !== "en" && card.translations ? card.translations[lang] : "";
    var phrase = card.phrase && card.phrase.meaning ? card.phrase : null;
    var phrasePlain = phrase ? simpleOf(phrase.meaning) : "";
    var phrasePos =
      phrase && phrase.definitions && phrase.definitions.length ? phrase.definitions[0].pos : "";
    var phraseAlt =
      phrase && lang !== "en" && phrase.translations ? phrase.translations[lang] : "";

    var html = '<article class="fcard fade-in"><div class="fc-split"><div class="fc-main">';
    html +=
      '<div class="fcard-label">' +
      (card.status === "new" ? "New word" : "Review · " + esc(FC.statusLabel(card))) +
      "</div>";
    html +=
      '<div class="word-row"><h1 class="word">' +
      esc(card.word) +
      "</h1>" +
      '<button class="say-btn" data-act="say" title="Hear the word" aria-label="Hear the word">🔊</button>' +
      "</div>";

    if (meaning || phrase) {
      /* English + every language the user picked in settings */
      var rowHtml =
        '<div class="lang-row"><span class="lang-row-label">Explain in</span>' +
        langBtn("en", "English", lang);
      var picked = trLangList();
      for (var li = 0; li < picked.length; li++)
        rowHtml += langBtn(picked[li], langName(picked[li]), lang);
      html += rowHtml + "</div>";

      /* The phrase the sentence actually uses (idiom / phrasal meaning) … */
      if (phrase) {
        html += '<div class="phrase-block">';
        html += '<div class="phrase-tag">In this sentence</div>';
        html += '<div class="phrase-text">' + esc(phrase.text) + "</div>";
        html += meaningBlock(phrasePlain, phrasePos, lang, phraseAlt);
        if (phrase.example) {
          html += '<div class="example-label">Example</div><p class="ex-sentence" id="phLine"></p>';
        }
        html += "</div>";
      }

      /* … and the word on its own. */
      if (meaning) {
        if (phrase) html += '<div class="defs-title">The word by itself</div>';
        html += meaningBlock(plain, defs.length && defs[0].pos ? defs[0].pos : "", lang, alt);
      }
    } else {
      html +=
        '<div class="no-meaning"><span>No meaning saved yet.</span>' +
        '<button class="btn btn-ghost btn-sm" data-act="lookup">Look it up</button></div>';
    }

    html += sentencesHtml(card, lang);

    var others = defs.length > 1 ? defs.slice(1, 4) : [];
    if (others.length) {
      html += '<div class="defs-title">Other meanings</div><ul class="defs">';
      others.forEach(function (d) {
        html +=
          "<li>" +
          (d.pos ? '<span class="pos">' + esc(d.pos) + "</span>" : "") +
          "<span>" +
          esc(d.text) +
          "</span></li>";
      });
      html += "</ul>";
    }

    if (card.context) {
      html +=
        '<div class="example-label">Seen in this video</div>' +
        '<blockquote class="context-quote" id="ctxQuote"></blockquote>';
      /* the sentence in every chosen language — so the clip is
         understandable even when the English line is not */
      var ctxTr = card.contextTr || {};
      trLangList().forEach(function (code) {
        if (ctxTr[code])
          html +=
            '<p class="ctx-tr" dir="auto" lang="' +
            code +
            '"><b class="ctx-tr-tag">' +
            esc(langName(code)) +
            "</b>" +
            esc(ctxTr[code]) +
            "</p>";
      });
    }

    if (card.videoUrl) {
      html +=
        '<a class="video-link" href="' +
        esc(card.videoUrl) +
        '" target="_blank" rel="noopener">' +
        "<span>▶</span><span class='vl-title'>" +
        esc(timeLabel(card.timeSec)) +
        (card.title ? " · " + esc(card.title) : "") +
        "</span></a>";
    }

    html +=
      '<div class="reveal-hint"><span style="color:var(--muted);font-size:14px">' +
      "How well did you know it?</span></div>";
    html += "</div>"; /* /fc-main */
    html += sideHtml(card, true);
    html += "</div></div></article>"; /* /fc-split /fcard */
    return html;
  }

  /* ------------------------------------------------------------ right column */
  /** Pronunciation player + film/TV clips — the right-hand column. */
  function sideHtml(card, revealed) {
    var list = sentencesOf(card);
    var html = '<aside class="fc-side">';

    html += '<div class="side-block sound-block">';
    html += '<div class="side-title">Pronunciation</div>';
    html += '<div class="sound-row">' +
      '<button class="sound-play" data-act="say" title="Hear the word" aria-label="Hear the word">▶</button>' +
      '<span class="sound-meta"><b class="sound-word">' +
      esc(card.word) +
      "</b>" +
      '<span class="ipa' +
      (card.pronunciation || card.pronDone ? "" : " is-loading") +
      '" id="ipaLine">' +
      esc(card.pronunciation || (card.pronDone ? "—" : "…")) +
      "</span></span>" +
      '<button class="sound-slow" data-act="say-slow" title="Hear it slowly" aria-label="Hear it slowly">🐢</button>' +
      "</div>";
    if (revealed && list.length)
      html +=
        '<button class="sound-line" data-say-sent="0">▶ Hear an example sentence</button>';
    html += "</div>";

    if (revealed) {
      /* The hosted web app cannot scrape youtube.com (cross-origin) or run
         the inline player (that needs the extension's bridge), so it shows
         only the plain "where else you can hear it" links — which are just
         anchors and work fine from any page. */
      if (IS_WEB) {
        html += '<div class="side-block clips-block">';
        html += '<div class="side-title">Hear it in movies &amp; animations</div>';
        html += '<div class="clip-links">' + clipLinksHtml(card) + "</div>";
        html += "</div>";
      } else {
      html += '<div class="side-block clips-block">';
      html += '<div class="side-title">In movies &amp; animations</div>';
      /* one video at a time: the stage holds the player, and under it the
         poster + bar that tell you which example you're on */
      html += '<div class="clip-stage">';
      html += '<div class="clip-player" id="clipPlayer" hidden></div>';
      html += '<div class="clip-info" id="clipList">' + clipsHtml(card) + "</div>";
      html += "</div>";
      html += '<div class="clip-links">' + clipLinksHtml(card) + "</div>";
      html += "</div>";
      }
    }

    html += "</aside>";
    return html;
  }

  /** Which example the stage is on (clamped — old cards may carry any value). */
  function clipIndex(card) {
    var n = ((card.clips && card.clips.items) || []).length;
    if (!n) return 0;
    var i = Number(card.clipIndex) || 0;
    if (i < 0 || i >= n) i = 0;
    return i;
  }

  function currentClip(card) {
    var items = (card.clips && card.clips.items) || [];
    return items[clipIndex(card)] || null;
  }

  /**
   * The stage: one poster to start the current example, plus the bar that
   * says which example this is and moves to the next — no list of thumbnails.
   */
  function clipsHtml(card) {
    if (card.clipsLoading) return '<div class="clip-loading">Finding clips…</div>';
    var items = (card.clips && card.clips.items) || [];
    if (!items.length)
      return '<div class="clip-empty">No clips found — try the links below.</div>';
    var i = clipIndex(card);
    var c = items[i];
    return (
      '<button class="clip-peek" type="button" data-clip="' +
      esc(c.id) +
      '" title="Play this example">' +
      (c.thumb
        ? '<img class="clip-poster" src="' + esc(c.thumb) + '" alt="" loading="lazy">'
        : '<span class="clip-poster"></span>') +
      '<span class="clip-play">▶</span>' +
      "</button>" +
      '<div class="clip-bar">' +
      '<span class="clip-now">' +
      esc(c.title || "Example") +
      "</span>" +
      '<span class="clip-count">' +
      (i + 1) +
      " of " +
      items.length +
      "</span>" +
      '<button class="clip-next" type="button" title="Show another example">Next example ▶</button>' +
      "</div>"
    );
  }

  /** Always-available clip searches (movie-quote engines + YouTube). */
  function clipLinksHtml(card) {
    var q = encodeURIComponent(card.word);
    var links = [
      ["YouTube scenes", "https://www.youtube.com/results?search_query=" + q + "+scene"],
      ["PlayPhrase", "https://playphrase.me/#/search?q=" + q],
      ["GetYarn", "https://getyarn.io/search?q=" + q],
      ["TED", "https://www.ted.com/search?q=" + q]
    ];
    return links
      .map(function (l) {
        return (
          '<a class="clip-link" href="' + l[1] + '" target="_blank" rel="noopener">' + l[0] + "</a>"
        );
      })
      .join("");
  }

  /* -------------------------------------------------------- inline player */

  /** null when we may still try; false when YouTube has already said no. */
  function clipPlayable(m) {
    if (!m) return null;
    if (m.playable === false) return false;
    if (m.embeddable === false) return false;
    return null;
  }

  /** Plain words for a refused clip — YouTube's own text when we have it. */
  function clipRefusal(m) {
    if (m && m.embeddable === false) return "Embedding is turned off for this clip";
    var r = m && m.playReason ? String(m.playReason).trim() : "";
    if (/not a bot/i.test(r)) return "YouTube wants a sign-in for this clip";
    if (/unavailable/i.test(r)) return "This video is unavailable";
    if (r) return "YouTube won’t play this clip — " + r;
    return "YouTube refused this clip";
  }

  /**
   * "Sign in to confirm you're not a bot" is YouTube rate-limiting an
   * anonymous request — it says nothing about the video and it lifts. Such a
   * verdict is shown but never stored, so the clip is asked again next time.
   */
  function softRefusal(m) {
    return !!m && m.playable === false && /sign in|not a bot|confirm you/i.test(m.playReason || "");
  }

  /**
   * Flag a clip as not playable. Soft refusals keep the ✕ only for this
   * session (non-enumerable → storage never sees it); a real verdict — the
   * uploader forbade embedding, the video is gone — is kept on the card.
   */
  function markUnavailable(clip, transient) {
    try {
      Object.defineProperty(clip, "unavailable", {
        value: true,
        enumerable: !transient,
        writable: true,
        configurable: true
      });
    } catch (e) {
      clip.unavailable = true;
    }
  }

  /** Click the poster → play just that moment inside the card, no navigation. */
  function playClip(card, id, host) {
    if (!card || !card.clips || !card.clips.items) return;
    var clip = null;
    var idx = -1;
    card.clips.items.forEach(function (c, i) {
      if (c.id === id) {
        clip = c;
        idx = i;
      }
    });
    if (!clip) return;

    /* keep the stage's "n of m" counter in step with whatever plays */
    if (idx > -1 && clipIndex(card) !== idx) {
      card.clipIndex = idx;
      renderStageInfo(card, host);
    }

    /* video URLs expire after a few hours — ask for a fresh moment then */
    if (
      clip.moment &&
      clip.moment.stream &&
      clip.moment.stream.expireAt &&
      Date.now() > clip.moment.stream.expireAt
    )
      clip.moment = null;

    var box = host.querySelector("#clipPlayer");
    if (!box) return;

    /* YouTube already turned this one down — don't ask it twice */
    if (clip.moment && clipPlayable(clip.moment) === false && !softRefusal(clip.moment)) {
      advanceClip(card, clip, host, clip.moment);
      return;
    }

    if (clip.moment) {
      mountPlayer(box, card, clip, host);
      return;
    }

    box.hidden = false;
    box.innerHTML = '<div class="player-loading">Finding the exact moment…</div>';
    markPlaying(host, id);

    FC.fetchClipMoment(clip.id, (card.phrase && card.phrase.text) || card.word)
      .catch(function () {
        return { found: false, start: 0, end: 0, reason: "unavailable" };
      })
      .then(function (m) {
        var verdict = m || { found: false, start: 0, end: 0, reason: "unavailable" };
        /* a rate-limit verdict is not a fact about the clip: show it now,
           but never freeze it onto the card — the next click asks again */
        if (!softRefusal(verdict)) clip.moment = verdict;
        var live = liveCopy(card);
        if (live && live !== card) live.clips = card.clips;
        saveQuiet(card);
        /* a sign-in demand is worth one real attempt — YouTube's player in a
           browser often gets through where the bare API call did not */
        if (clipPlayable(verdict) === false && !softRefusal(verdict)) {
          advanceClip(card, clip, host, verdict);
          return;
        }
        var fresh = host.querySelector("#clipPlayer");
        mountPlayer(fresh || box, card, clip, host, verdict);
      });
  }

  /**
   * YouTube won't serve this clip: say so, then move on to the next example —
   * wrapping around the set. Only when every clip has been tried does the card
   * give up, and then it shows exactly what YouTube said, with a link.
   */
  function advanceClip(card, clip, host, verdict) {
    if (!verdict) verdict = clip.moment;
    markUnavailable(clip, softRefusal(verdict));
    var live = liveCopy(card);
    if (live && live !== card) live.clips = card.clips;
    saveQuiet(card);

    var items = (card.clips && card.clips.items) || [];
    var from = 0;
    items.forEach(function (c, i) {
      if (c.id === clip.id) from = i;
    });
    var next = null;
    var nextIdx = -1;
    for (var k = 1; k <= items.length && !next; k++) {
      var n = (from + k) % items.length;
      if (items[n].id !== clip.id && !items[n].unavailable) {
        next = items[n];
        nextIdx = n;
      }
    }

    var box = host.querySelector("#clipPlayer");
    if (!box) return;
    if (!next) {
      /* nothing left to try — this is the real answer, show it */
      mountPlayer(box, card, clip, host, verdict || clip.moment);
      return;
    }

    card.clipIndex = nextIdx;
    if (live && live !== card) live.clipIndex = nextIdx;
    saveQuiet(card);
    renderStageInfo(card, host);

    box.hidden = false;
    box.innerHTML =
      '<div class="player-loading">' +
      esc(clipRefusal(verdict)) +
      " — trying the next example…</div>";
    markPlaying(host, clip.id);
    setTimeout(function () {
      playClip(card, next.id, host);
    }, 900);
  }

  /** Focus the stage: while a clip plays its poster gives way to the video,
   *  and the card widens into a single big column for it. */
  function markPlaying(host, id) {
    var q = host && host.querySelector ? host : null;
    var block = q && q.querySelector(".clips-block");
    if (block && block.classList) block.classList.toggle("is-playing", !!id);
    var cardEl = q && q.querySelector(".fcard");
    if (cardEl && cardEl.classList) cardEl.classList.toggle("is-watching", !!id);
  }

  /** Redraw the poster + counter (the player box is a sibling — untouched). */
  function renderStageInfo(card, host) {
    var el = host && host.querySelector ? host.querySelector("#clipList") : null;
    if (el) el.innerHTML = clipsHtml(card);
  }

  /** The stage only ever shows one example — this moves to the next one. */
  function nextClip(card, host) {
    var items = (card.clips && card.clips.items) || [];
    if (!items.length) return;
    card.clipIndex = (clipIndex(card) + 1) % items.length;
    var live = liveCopy(card);
    if (live && live !== card) live.clipIndex = card.clipIndex;
    saveQuiet(card);
    renderStageInfo(card, host);
    var c = currentClip(card);
    if (c) playClip(card, c.id, host);
  }

  /*
   * The clip player can't be a plain embed in this page: YouTube blocks any
   * playback whose request arrives without a HTTP Referer (errors 153 and
   * 152-4), and no browser sends one from a chrome-extension:// page. So the
   * card loads a youtube.com frame and asks bridge.js — which runs inside it
   * — to mount YouTube's own player there, where the embedder is a real page
   * with a referrer of its own.
   */
  var hostTick = null;
  var hostTimer = null;
  var hostListener = null;

  function stopTimers() {
    if (hostTick) clearInterval(hostTick);
    if (hostTimer) clearTimeout(hostTimer);
    hostTick = hostTimer = null;
  }

  /* stop listening only when we're done with this frame for good — the
     answer "it's mounted" must not deafen us to "it was refused" */
  function stopHostedPlayer() {
    stopTimers();
    if (hostListener) window.removeEventListener("message", hostListener);
    hostListener = null;
  }

  /**
   * The document the player hangs off. Attempt 0 is YouTube's privacy-enhanced
   * embed domain — a real, framable embed page, but *not* www.youtube.com, so
   * the player never looks like it is embedding YouTube inside YouTube.
   * Attempt 1 is the plain embed page (the only www.youtube.com URL that
   * carries no X-Frame-Options). The hash marks the frame as ours, so
   * bridge.js only ever touches the frame this card created.
   */
  function hostUrl(clip, attempt) {
    var mark = "#fc-" + Math.random().toString(36).slice(2);
    return (attempt === 0
      ? "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(clip.id)
      : "https://www.youtube.com/embed/" + encodeURIComponent(clip.id)) + mark;
  }

  /** Ask a fresh youtube.com frame to host YouTube's player for us.
   *  `card` / `host` are only so a player-level refusal can move the stage on
   *  to the next example instead of dead-ending. */
  function startHostedPlayer(box, clip, m, attempt, card, host) {
    stopHostedPlayer();
    var frameBox = box.querySelector(".player-frame");
    if (!frameBox || !document.createElement) return;
    attempt = attempt || 0;

    /* start each attempt from clean: spinner back, previous frame gone */
    frameBox.innerHTML =
      '<div class="player-loading">' +
      (attempt ? "Trying another way to play…" : "Starting the player…") +
      "</div>";

    var iframe = document.createElement("iframe");
    iframe.className = "player-host";
    iframe.title = clip.title || "Clip";
    iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
    iframe.setAttribute("allowfullscreen", "");
    /* send this frame's own address along with its request — the extension
       page above it never would, and YouTube won't play without one */
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    /* stay invisible until the frame has actually become the player */
    iframe.setAttribute("style", "opacity:0");
    iframe.src = hostUrl(clip, attempt);
    frameBox.appendChild(iframe);

    var sent = 0;
    var post = function () {
      if (!iframe.contentWindow) return;
      try {
        iframe.contentWindow.postMessage(
          {
            fc: 1,
            type: "fc:host-player",
            videoId: clip.id,
            start: Math.max(0, Math.floor(Number(m.start) || 0)),
            end: Math.ceil(Number(m.end) || 0)
          },
          "https://www.youtube.com"
        );
      } catch (e) {
        /* still loading — the ticker keeps trying */
      }
    };

    hostListener = function (ev) {
      var d = ev.data;
      if (ev.origin !== "https://www.youtube.com" || !d || d.fc !== 1) return;
      if (d.type === "fc:host-player-ok") {
        stopTimers();
        iframe.setAttribute("style", "opacity:1");
        var spin = frameBox.querySelector(".player-loading");
        if (spin && spin.parentNode) spin.parentNode.removeChild(spin);
      } else if (d.type === "fc:host-player-error") {
        if (!attempt) {
          /* this host document was refused — try the other one before
             showing the user anything */
          startHostedPlayer(box, clip, m, 1, card, host);
        } else if (card && host && clipLevelError(d.error)) {
          /* the video itself is the problem — say so, then move the stage
             on to the next example instead of dead-ending here */
          playerRefused(box, clip, card, host, d.error);
        } else {
          showRefusal(frameBox, clip, d.error);
        }
      } else if (d.type === "fc:host-player-failed") {
        hostPlayerFailed(frameBox, clip);
      }
    };
    window.addEventListener("message", hostListener);

    post();
    /* these hosts are real pages, not a blank file — they can take a few
       seconds to load, so keep knocking for a good ten */
    hostTick = setInterval(function () {
      if (++sent >= 25) {
        clearInterval(hostTick);
        hostTick = null;
      } else {
        post();
      }
    }, 400);
    hostTimer = setTimeout(function () {
      /* this document never answered — give the other host a go before
         handing the clip over to YouTube */
      if (!frameBox.querySelector(".player-loading")) return;
      if (!attempt) startHostedPlayer(box, clip, m, 1, card, host);
      else hostPlayerFailed(frameBox, clip);
    }, attempt ? 9000 : 7000);
  }

  function hostPlayerFailed(frameBox, clip) {
    stopHostedPlayer();
    frameBox.innerHTML =
      '<div class="player-loading">This clip can’t be played here — ' +
      '<a class="player-open" href="' +
      esc(clip.url) +
      '" target="_blank" rel="noopener">open it on YouTube ↗</a></div>';
  }

  /** YouTube answered the player itself — say what it said, then hand over. */
  function showRefusal(frameBox, clip, error) {
    stopHostedPlayer();
    frameBox.innerHTML =
      '<div class="player-loading">YouTube refused this clip' +
      (error ? " — " + esc(error) : "") +
      ' — <a class="player-open" href="' +
      esc(clip.url) +
      '" target="_blank" rel="noopener">open it on YouTube ↗</a></div>';
  }

  /**
   * Refusals that are about *this video* — the next example may play fine.
   * 153 / 152-4 are about our frame, not the video, so those stay put.
   */
  function clipLevelError(error) {
    var e = String(error || "");
    if (!e) return false;
    if (/unavailable|sign in|not a bot|embedding|private|removed/i.test(e)) return true;
    return /^\s*(101|150)\s*$/.test(e);
  }

  /** The player itself turned the video down: report it, then move on. */
  function playerRefused(box, clip, card, host, error) {
    stopHostedPlayer();
    advanceClip(card, clip, host, {
      found: false,
      start: 0,
      end: 0,
      reason: "unplayable",
      playable: false,
      playReason: /sign in|not a bot/i.test(String(error || ""))
        ? "Sign in to confirm you’re not a bot"
        : String(error || "").trim()
    });
  }

  /** Mount the clip player stopped at the moment the word is spoken.
   *  `verdict` overrides the stored moment when it is too new to store. */
  function mountPlayer(box, card, clip, host, verdict) {
    if (!box) return;
    var m = verdict || clip.moment || { found: false, start: 0, end: 0 };
    /* A hard "no" (embedding switched off, video gone) would only produce the
       player's own error screen — say it instead. A sign-in demand is
       different: the player inside a real browser often gets through where
       the bare API call did not, so that one gets a genuine attempt. */
    var soft = softRefusal(m);
    var refused = clipPlayable(m) === false && !soft;
    var note;
    if (refused) {
      note = clipRefusal(m);
    } else if (soft) {
      note = "Trying anyway — YouTube may ask for a sign-in";
    } else if (m.found) {
      note =
        "Just this moment · " +
        timeLabel(Math.floor(m.start)) +
        "–" +
        timeLabel(Math.floor(m.end));
    } else if (m.reason === "no-captions" || m.reason === "no-english" || m.reason === "empty-captions") {
      note = "No captions for this clip — from the start";
    } else if (m.reason === "word-not-in-captions") {
      note = "Word not in the captions — from the start";
    } else {
      note = "Playing from the start";
    }

    var frameInner;
    if (refused) {
      frameInner =
        '<div class="player-loading">' +
        esc(note) +
        " — <a " +
        'class="player-open" href="' +
        esc(clip.url) +
        '" target="_blank" rel="noopener">open it on YouTube ↗</a></div>';
    } else {
      frameInner = '<div class="player-loading">Starting the player…</div>';
    }

    box.hidden = false;
    box.innerHTML =
      '<div class="player-frame">' +
      frameInner +
      '</div><div class="player-bar"><span class="player-note">' +
      esc(note) +
      '</span><a class="player-open" href="' +
      esc(clip.url) +
      '" target="_blank" rel="noopener">YouTube ↗</a>' +
      '<button class="player-close" title="Close player" aria-label="Close player">✕</button></div>';

    var close = box.querySelector(".player-close");
    if (close)
      close.addEventListener("click", function () {
        stopHostedPlayer();
        box.innerHTML = "";
        box.hidden = true;
        markPlaying(host, "");
      });
    markPlaying(host, clip.id);
    if (refused) return;
    /* the player API handed over a video URL with the captions — play the
       moment straight from it, no embed, no referrer, no waiting */
    if (startStream(box, clip, m, card, host)) return;
    startHostedPlayer(box, clip, m, 0, card, host);
  }

  /**
   * Play the moment from the video URL YouTube sent along with the captions:
   * a plain <video> — it starts on the word's own sentence and stops at its
   * end. Returns false when there is no usable URL (missing or expired), so
   * the hosted player can take over.
   */
  function startStream(box, clip, m, card, host) {
    var s = m && m.stream;
    if (!s || !s.url) return false;
    if (s.expireAt && Date.now() > s.expireAt) return false;
    var frameBox = box.querySelector(".player-frame");
    if (!frameBox || !document.createElement) return false;
    var vid = document.createElement("video");
    if (!vid || !vid.setAttribute) return false;

    var start = Math.max(0, Math.floor(Number(m.start) || 0));
    var end = Math.ceil(Number(m.end) || 0);

    vid.className = "moment-video";
    vid.setAttribute("controls", "");
    vid.setAttribute("playsinline", "");
    vid.setAttribute("preload", "auto");
    vid.setAttribute("src", s.url);
    frameBox.innerHTML = "";
    frameBox.appendChild(vid);

    if (vid.addEventListener) {
      vid.addEventListener("loadedmetadata", function () {
        try {
          if (start && vid.currentTime !== undefined) vid.currentTime = start;
        } catch (e) {
          /* seek before metadata — harmless */
        }
        try {
          if (vid.play) {
            var p = vid.play();
            if (p && p.catch) p.catch(function () {
              /* autoplay held back: the controls are right there */
            });
          }
        } catch (e) {
          /* no player yet */
        }
      });
      vid.addEventListener("timeupdate", function () {
        if (end && vid.currentTime >= end) {
          try {
            vid.pause();
            vid.currentTime = start;
          } catch (e) {
            /* loop is a nicety */
          }
        }
      });
      vid.addEventListener("error", function () {
        /* the URL expired or YouTube cut the stream — same road as if there
           had never been one */
        startHostedPlayer(box, clip, m, 0, card, host);
      });
    }
    return true;
  }

  /* -------------------------------------------------------- example sentences */
  function sentencesOf(card) {
    if (card && card.examples && card.examples.length) return card.examples;
    return card && card.example ? [card.example] : [];
  }

  function sentencesHtml(card, lang) {
    var list = sentencesOf(card);
    if (!list.length) return "";
    var tr = lang !== "en" && card.exampleTr ? card.exampleTr[lang] : null;
    var html =
      '<div class="example-label">Example sentences</div><ul class="sent-list" id="sentList">';
    list.forEach(function (s, i) {
      var alt = tr && tr[i] ? tr[i] : "";
      html += "<li>";
      html += '<p class="ex-sentence" data-sent="' + i + '"></p>';
      html +=
        '<div class="sent-foot"><button class="mini-say" data-say-sent="' +
        i +
        '" title="Hear this sentence" aria-label="Hear this sentence">🔊</button>';
      if (lang !== "en")
        html +=
          '<span class="sent-tr' +
          (alt ? "" : " is-loading") +
          '" dir="rtl" lang="' +
          esc(lang) +
          '">' +
          esc(alt || "Translating…") +
          "</span>";
      html += "</div></li>";
    });
    html += "</ul>";
    return html;
  }

  function langBtn(code, label, current) {
    return (
      '<button class="lang-btn' +
      (current === code ? " is-on" : "") +
      '" data-lang="' +
      code +
      '">' +
      esc(label) +
      "</button>"
    );
  }

  /** Duolingo-style plain-English rendering of a stored meaning. */
  function simpleOf(s) {
    var t = cleanText(s);
    return (typeof FC.simpleExplain === "function" ? FC.simpleExplain(t) : t) || t;
  }

  /** One meaning block: part-of-speech chip + chosen-language text. */
  function meaningBlock(text, pos, lang, alt) {
    var html = '<div class="duo-meaning">';
    if (pos) html += '<span class="pos-chip">' + esc(pos) + "</span>";
    if (lang === "en") {
      html += '<p class="meaning">' + esc(text) + "</p>";
    } else if (alt) {
      html += '<p class="meaning meaning-alt" dir="rtl" lang="' + esc(lang) + '">' + esc(alt) + "</p>";
    } else {
      html += '<p class="meaning meaning-loading">Translating…</p>';
    }
    html += "</div>";
    return html;
  }

  /* ------------------------------------------------------------- voice (TTS) */
  /** Speak text with the built-in browser voices — normal or slow rate. */
  function speak(text, slow) {
    text = cleanText(text);
    if (!text) return false;
    var synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      toast("Voice playback isn't available here");
      return false;
    }
    try {
      synth.cancel();
      var u = new SpeechSynthesisUtterance(text);
      var voices = synth.getVoices() || [];
      var pick = null;
      for (var i = 0; i < voices.length; i++) {
        if (!/^en[-_]/i.test(voices[i].lang)) continue;
        pick = pick || voices[i];
        if (/en[-_]US/i.test(voices[i].lang)) {
          pick = voices[i];
          break;
        }
      }
      if (pick) u.voice = pick;
      u.lang = (pick && pick.lang) || "en-US";
      u.rate = slow ? 0.62 : 0.95;
      synth.speak(u);
      return true;
    } catch (e) {
      toast("Voice playback failed");
      return false;
    }
  }

  /** Every 🔊 / ▶ on the card: word buttons and per-sentence buttons. */
  function wireSay(host) {
    $$(".say-btn, .sound-play, .sound-slow", host).forEach(function (b) {
      b.addEventListener("click", function () {
        var card = state.queue[state.idx];
        if (card) speak(card.word, b.classList.contains("sound-slow"));
      });
    });
    $$(".mini-say, .sound-line", host).forEach(function (b) {
      b.addEventListener("click", function () {
        var card = state.queue[state.idx];
        if (!card) return;
        var list = sentencesOf(card);
        var text = list[Number(b.dataset.saySent) || 0] || list[0];
        if (text) speak(text, false);
      });
    });
  }

  function gradesHtml(card) {
    var html = '<div class="grades">';
    FC.GRADES.forEach(function (g, i) {
      html +=
        '<button class="grade ' +
        g +
        '" data-grade="' +
        g +
        '"><span class="g-name">' +
        cap(g) +
        '</span><span class="g-when">' +
        esc(FC.gradeLabel(card, g)) +
        " · " +
        (i + 1) +
        "</span></button>";
    });
    html += "</div>";
    return html;
  }

  function wireFront(host) {
    var btn = host.querySelector('[data-act="reveal"]');
    if (btn) btn.addEventListener("click", reveal);

    var cloze = host.querySelector("#clozeLine");
    var card = state.queue[state.idx];
    if (cloze && card && card.context) cloze.appendChild(clozeContext(card.context, card.word));

    if (card) {
      wireSay(host);
      loadPronunciation(card, host);
    }

    var link = host.querySelector(".video-link");
    if (link) link.addEventListener("click", function (e) {
      e.stopPropagation();
    });
  }

  function wireGrades(host) {
    var card = state.queue[state.idx];

    var quote = host.querySelector("#ctxQuote");
    if (quote && card && card.context) quote.appendChild(highlightContext(card.context, card.word));

    /* example sentences: the word highlighted inside each one */
    if (card) {
      var sentences = sentencesOf(card);
      $$("[data-sent]", host).forEach(function (p) {
        var s = sentences[Number(p.dataset.sent)];
        if (s) p.appendChild(highlightContext(s, card.word));
      });
    }

    var ph = host.querySelector("#phLine");
    if (ph && card && card.phrase && card.phrase.example)
      ph.appendChild(highlightContext(card.phrase.example, card.word));

    if (card) {
      wireSay(host);
      loadPronunciation(card, host);
      /* clip search scrapes youtube.com — only the extension can reach it */
      if (!IS_WEB) loadClips(card, host);
      loadSentences(card);
      loadContextTr(card, host);
    }

    /* clips play inline — delegated, so clips that arrive after the render
       (and re-renders) keep working */
    var clipsBlock = host.querySelector(".clips-block");
    if (clipsBlock && card) {
      clipsBlock.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        /* the one button on the stage: jump to the next example */
        if (t.closest(".clip-next")) {
          e.preventDefault();
          nextClip(card, host);
          return;
        }
        /* the poster starts the current example — same data-clip contract
           the old thumbnail list used */
        var a = t.closest("[data-clip]");
        if (!a || !clipsBlock.contains(a)) return;
        e.preventDefault();
        playClip(card, a.dataset.clip, host);
      });
    }

    /* Explanation language: English + every chosen language */
    $$(".lang-btn", host).forEach(function (b) {
      b.addEventListener("click", function () {
        var to = b.dataset.lang;
        if (state.explain === to) return;
        state.explain = to;
        renderToday();
        if (to !== "en" && card && needsTranslation(card, to)) {
          fetchTranslation(card, to);
        }
      });
    });

    if (card && needsTranslation(card, state.explain)) {
      fetchTranslation(card, state.explain);
    }

    var lookup = host.querySelector('[data-act="lookup"]');
    if (lookup && card) {
      lookup.addEventListener("click", function () {
        lookupMeaningFor(card, function () {
          renderToday();
        });
      });
    }

    $$(".grade", host).forEach(function (b) {
      b.addEventListener("click", function () {
        grade(b.dataset.grade);
      });
    });
  }

  /* ------------------------------------------------- lazy right-column loads */
  function liveCopy(card) {
    return state.cards.filter(function (c) {
      return c.norm === card.norm;
    })[0];
  }

  function saveQuiet(card) {
    return FC.saveCard(card).catch(function () {});
  }

  /** IPA transcription — fetched once, shown under the word. */
  function loadPronunciation(card, host) {
    if (!card || card.pronDone || card.pronLoading) return;
    card.pronLoading = true;
    FC.fetchPronunciation(card.word)
      .catch(function () {
        return "";
      })
      .then(function (ipa) {
        card.pronLoading = false;
        card.pronDone = true;
        card.pronunciation = ipa || "";
        var live = liveCopy(card);
        if (live && live !== card) live.pronunciation = card.pronunciation;
        saveQuiet(card);
        var el = host && host.querySelector("#ipaLine");
        if (el) {
          el.textContent = card.pronunciation || "—";
          el.classList.remove("is-loading");
        }
      });
  }

  /** Film / TV / cartoon clips for this word — searched once, then cached. */
  function loadClips(card, host) {
    if (!card || card.clips || card.clipsLoading) return;
    card.clipsLoading = true;
    var box = host && host.querySelector("#clipList");
    if (box) box.innerHTML = clipsHtml(card);

    var phrase = card.phrase && card.phrase.text ? card.phrase.text : "";
    FC.fetchClips(card.word, phrase)
      .catch(function () {
        return { query: "", items: [] };
      })
      .then(function (res) {
        card.clipsLoading = false;
        card.clips = res && res.items ? res : { query: "", items: [] };
        var live = liveCopy(card);
        if (live && live !== card) live.clips = card.clips;
        saveQuiet(card);
        var el = host && host.querySelector("#clipList");
        if (el) el.innerHTML = clipsHtml(card);
      });
  }

  /** Older cards only stored one sentence — upgrade them to four. */
  function loadSentences(card) {
    if (!card || card.examples || card.sentLoading) return;
    card.sentLoading = true;
    FC.fetchExamples(card.word, 4)
      .then(function (list) {
        card.sentLoading = false;
        if (!list || !list.length) {
          card.examples = card.example ? [card.example] : [];
          return;
        }
        card.examples = list;
        if (!card.example) card.example = list[0];
        var live = liveCopy(card);
        if (live && live !== card) {
          live.examples = card.examples;
          live.example = card.example;
        }
        saveQuiet(card);
        if (state.revealed && state.queue[state.idx] === card) renderToday();
      })
      .catch(function () {
        card.sentLoading = false;
      });
  }

  /** The clicked sentence in every chosen language, so the clip is readable
   *  even when the English line is not. Cached on the card; re-renders once. */
  function loadContextTr(card, host) {
    if (!card || !card.context) return;
    var langs = trLangList();
    var have = card.contextTr || {};
    var missing = langs.some(function (code) {
      return !have[code];
    });
    if (!langs.length || !missing || card.ctxTrLoading) return;
    if (card.ctxTrLoading) return;
    card.ctxTrLoading = true;
    FC.loadTranslations(card)
      .then(function () {
        card.ctxTrLoading = false;
        if (host && host.isConnected === false) return;
        if (state.revealed && state.queue[state.idx] === card) renderToday();
      })
      .catch(function () {
        card.ctxTrLoading = false;
      });
  }

  function reveal() {
    if (state.revealed) return;
    state.revealed = true;
    renderToday();
  }

  async function grade(g) {
    var card = state.queue[state.idx];
    if (!card) return;

    // refresh from the store so we never resurrect a deleted card
    var live = state.cards.filter(function (c) {
      return c.norm === card.norm;
    })[0];
    if (!live) {
      state.queue.splice(state.idx, 1);
      renderToday();
      return;
    }

    var wasNew = live.status === "new";
    FC.schedule(live, g, Date.now());
    await FC.saveCard(live);

    state.stats = FC.recordReview(state.stats, wasNew, Date.now());
    await FC.saveStats(state.stats);

    if (g === "again") {
      // still due, take another look later in this session
      state.queue.splice(state.idx, 1);
      state.queue.push(live);
    } else {
      state.idx++;
    }

    state.revealed = false;
    renderStreak();

    if (state.idx >= state.queue.length) {
      state.summary = { count: state.queue.length };
      state.queue = [];
      state.idx = 0;
    }
    renderToday();
  }

  function emptyStateHtml(sum, finished) {
    var html = "";

    if (finished && state.summary) {
      html +=
        '<div class="done-card fade-in"><div class="done-emoji">🎉</div>' +
        "<h2>Nice session!</h2><p>You reviewed <b>" +
        state.summary.count +
        "</b> word" +
        (state.summary.count === 1 ? "" : "s") +
        (sum.streak > 1 ? " and kept a " + sum.streak + "-day streak going" : "") +
        ".</p></div>";
    } else if (state.cards.length === 0) {
      html +=
        '<div class="done-card fade-in"><div class="done-emoji">🎬</div>' +
        "<h2>Save your first word</h2>" +
        "<p>Open a YouTube video, turn on the subtitles (<b>CC</b>) and click any word you don't know — it lands here as a flashcard.</p>" +
        '<div class="done-actions">' +
        '<a class="btn" href="https://www.youtube.com" target="_blank" rel="noopener">Open YouTube</a>' +
        "</div></div>";
    } else {
      html +=
        '<div class="done-card fade-in"><div class="done-emoji">✅</div>' +
        "<h2>You're all caught up</h2><p>" +
        (sum.nextDueLabel
          ? "Next review " + esc(sum.nextDueLabel) + "."
          : "Nothing to review right now.") +
        " Keep watching videos and click the words you don't know.</p>" +
        '<div class="done-actions">' +
        '<a class="btn" href="https://www.youtube.com" target="_blank" rel="noopener">Watch & add words</a>' +
        '<button class="btn btn-ghost" data-act="library">Browse library</button>' +
        "</div></div>";
    }

    html += '<div class="stats-grid">' +
      stat(sum.total, "words saved") +
      stat(sum.due, "due now") +
      stat(sum.mastered, "mastered") +
      stat(sum.streak, "day streak") +
      stat(sum.reviewsToday, "reviews today") +
      stat(sum.totalReviews, "reviews all time") +
      "</div>";
    return html;
  }

  function stat(v, k) {
    return (
      '<div class="stat"><div class="s-val">' +
      (v || 0) +
      '</div><div class="s-key">' +
      k +
      "</div></div>"
    );
  }

  function wireEmptyState(host) {
    var b = host.querySelector('[data-act="library"]');
    if (b)
      b.addEventListener("click", function () {
        setView("library");
      });
  }

  /* ------------------------------------------------------------- LIBRARY */
  function renderLibrary() {
    var host = $("#libraryBody");
    var q = state.search.trim().toLowerCase();
    var now = Date.now();

    var list = state.cards.filter(function (c) {
      if (state.filter === "due" && c.srs.due > now) return false;
      if (state.filter === "learning" && c.status !== "learning" && c.status !== "review")
        return false;
      if (state.filter === "mastered" && c.status !== "mastered") return false;
      if (!q) return true;
      return (
        c.word.toLowerCase().indexOf(q) > -1 ||
        (c.meaning || "").toLowerCase().indexOf(q) > -1 ||
        (c.context || "").toLowerCase().indexOf(q) > -1
      );
    });

    list.sort(function (a, b) {
      var ad = a.srs.due <= now ? 0 : 1;
      var bd = b.srs.due <= now ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.word.localeCompare(b.word);
    });

    $("#libCount").textContent =
      list.length === state.cards.length
        ? state.cards.length + " words"
        : list.length + " of " + state.cards.length + " words";

    if (!state.cards.length) {
      host.innerHTML =
        '<div class="empty-list"><b>No words yet.</b><br>Click a word in a YouTube video\'s subtitles and it will show up here.</div>';
      return;
    }
    if (!list.length) {
      host.innerHTML = '<div class="empty-list"><b>Nothing matches.</b><br>Try another search or filter.</div>';
      return;
    }

    host.innerHTML = '<ul class="card-list">' + list.map(rowHtml).join("") + "</ul>";
    wireLibrary(host);
  }

  function rowHtml(c) {
    var now = Date.now();
    var isDue = c.srs.due <= now;
    var pillClass = isDue ? "due" : c.status;
    var pillText = isDue ? "Due now" : FC.statusLabel(c);

    var html =
      '<li class="lrow" data-norm="' + esc(c.norm) + '">' +
      '<div class="lrow-main" data-act="toggle">' +
      '<span class="lrow-word">' + esc(c.word) + "</span>" +
      '<span class="lrow-meaning' +
      (c.meaning ? "" : " is-empty") +
      '">' +
      esc(c.meaning || "no meaning yet") +
      "</span>" +
      '<span class="pill ' + pillClass + '">' + esc(pillText) + "</span>" +
      '<span class="lrow-actions">' +
      (c.videoUrl
        ? '<a class="row-btn" href="' +
          esc(c.videoUrl) +
          '" target="_blank" rel="noopener" title="Watch at ' +
          esc(timeLabel(c.timeSec)) +
          '" data-stop="1">▶</a>'
        : "") +
      '<button class="row-btn" data-act="review" title="Review this word now">✓</button>' +
      '<button class="row-btn danger" data-act="delete" title="Delete">✕</button>' +
      "</span></div>" +
      '<div class="lrow-detail">' +
      (c.phrase && c.phrase.meaning
        ? '<div class="detail-block phrase-block">' +
          '<div class="detail-key phrase-tag">In this sentence</div>' +
          '<div class="phrase-text">' +
          esc(c.phrase.text) +
          "</div>" +
          '<div class="meaning">' +
          esc(simpleOf(c.phrase.meaning)) +
          "</div>" +
          (c.phrase.example ? '<p class="ex-sentence">' + esc(c.phrase.example) + "</p>" : "") +
          "</div>"
        : "") +
      '<div class="detail-block"><div class="detail-key">Meaning</div>' +
      '<textarea class="meaning-edit" spellcheck="false">' +
      esc(cleanText(c.meaning || "")) +
      "</textarea>" +
      '<div class="btn-row"><button class="btn btn-sm" data-act="save-meaning">Save meaning</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="lookup">Find meaning</button></div></div>';

    if (c.definitions && c.definitions.length) {
      html += '<div class="detail-block"><div class="detail-key">Definitions</div><ul class="defs">';
      c.definitions.slice(0, 4).forEach(function (d) {
        var text = cleanText(d.text);
        if (!text) return;
        html +=
          "<li>" +
          (d.pos ? '<span class="pos">' + esc(d.pos) + "</span>" : "") +
          "<span>" + esc(text) + "</span></li>";
      });
      html += "</ul></div>";
    }

    if (c.context) {
      html +=
        '<div class="detail-block"><div class="detail-key">Seen in</div>' +
        '<div class="detail-context" data-context="' +
        esc(c.context) +
        '"></div></div>';
    }

    html +=
      '<div class="detail-block"><div class="detail-key">Progress</div>' +
      '<div class="field-hint">' +
      esc(FC.statusLabel(c)) +
      " · " +
      esc(FC.dueLabel(c, now)) +
      " · " +
      (c.srs.reps || 0) +
      " review" +
      ((c.srs.reps || 0) === 1 ? "" : "s") +
      " · added " +
      esc(new Date(c.createdAt || now).toLocaleDateString()) +
      (c.videoId ? " · " + esc(c.videoId) : "") +
      "</div></div></div></li>";

    return html;
  }

  function wireLibrary(host) {
    $$(".lrow", host).forEach(function (row) {
      var norm = row.dataset.norm;
      var card = cardByNorm(norm);
      if (!card) return;

      var ctx = row.querySelector(".detail-context");
      if (ctx) {
        ctx.appendChild(highlightContext(card.context, card.word));
        ctx.removeAttribute("data-context");
      }

      row.querySelector('[data-act="toggle"]').addEventListener("click", function (e) {
        if (e.target.closest("[data-stop]")) return;
        if (e.target.closest("button, a")) return;
        row.classList.toggle("is-open");
      });

      var del = row.querySelector('[data-act="delete"]');
      if (del)
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          if (!confirm('Delete "' + card.word + '" from your flashcards?')) return;
          FC.deleteCard(card.norm).then(function () {
            toast("Deleted “" + card.word + "”");
            reloadCards(true).then(render);
          });
        });

      var rev = row.querySelector('[data-act="review"]');
      if (rev)
        rev.addEventListener("click", function (e) {
          e.stopPropagation();
          state.queue = [card];
          state.idx = 0;
          state.revealed = false;
          state.summary = null;
          setView("today");
        });

      var save = row.querySelector('[data-act="save-meaning"]');
      if (save)
        save.addEventListener("click", function () {
          var val = row.querySelector(".meaning-edit").value.trim();
          card.meaning = val;
          card.meaningSource = val ? "manual" : "";
          FC.saveCard(card).then(function () {
            toast(val ? "Meaning saved" : "Meaning cleared");
            reloadCards().then(render);
          });
        });

      var lk = row.querySelector('[data-act="lookup"]');
      if (lk)
        lk.addEventListener("click", function () {
          lk.disabled = true;
          lk.textContent = "…";
          lookupMeaningFor(card, function () {
            renderLibrary();
          });
        });
    });
  }

  function cardByNorm(norm) {
    return (
      state.cards.filter(function (c) {
        return c.norm === norm;
      })[0] || null
    );
  }

  /* ------------------------------------------------------------- SETTINGS */
  /** The "Translate into" checkbox grid — one box per language in FC.LANGS. */
  function renderTrLangChecks() {
    var box = $("#setTrLangs");
    if (!box || !FC.LANGS) return;
    var sel = state.settings.trLangs || [];
    box.innerHTML = FC.LANGS.map(function (l) {
      var on = sel.indexOf(l.code) > -1;
      return (
        '<label class="lang-check' +
        (on ? " is-on" : "") +
        '"><input type="checkbox" value="' +
        l.code +
        '"' +
        (on ? " checked" : "") +
        " /><span>" +
        esc(l.name) +
        "</span></label>"
      );
    }).join("");
  }

  function syncSettingsForm() {
    var s = state.settings;
    var lang = $("#setLang");
    if (lang && s.lang) lang.value = s.lang;
    renderTrLangChecks();
    var npd = $("#setNewPerDay");
    if (npd && document.activeElement !== npd) npd.value = s.newPerDay;
    var rem = $("#setReminder");
    if (rem && document.activeElement !== rem) rem.value = s.reminder || "";
    var en = $("#setEnabled");
    if (en) en.checked = s.enabled !== false;
    var sh = $("#setShowHints");
    if (sh) sh.checked = s.showHints !== false;
    var th = $("#setTheme");
    if (th) th.value = s.theme || "auto";
  }

  async function saveSetting(patch) {
    state.settings = await FC.saveSettings(patch);
    applyTheme();
    if (patch.enabled !== undefined || patch.showHints !== undefined) {
      // nothing else to do, the content script picks changes up on its own
    }
  }

  function applyTheme() {
    var mode = state.settings.theme || "auto";
    if (mode === "auto") {
      mode =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    }
    document.documentElement.dataset.theme = mode;
  }

  /* --------------------------------------------------------------- events */
  function bindStaticEvents() {
    $("#nav").addEventListener("click", function (e) {
      var b = e.target.closest(".nav-btn");
      if (b) setView(b.dataset.view);
    });

    $("#themeBtn").addEventListener("click", function () {
      var cur = document.documentElement.dataset.theme;
      saveSetting({ theme: cur === "dark" ? "light" : "dark" }).then(render);
    });

    /* Add-words view (paste/share → tap to save) */
    var addTok = $("#addTokenizeBtn");
    if (addTok) {
      addTok.addEventListener("click", function () {
        tokenizeInto(($("#addText").value || "").trim());
      });
    }
    var addClear = $("#addClearBtn");
    if (addClear) {
      addClear.addEventListener("click", function () {
        var area = $("#addText");
        if (area) area.value = "";
        var host = $("#addTokens");
        if (host) host.innerHTML = "";
        var status = $("#addStatus");
        if (status) {
          status.hidden = true;
          status.innerHTML = "";
        }
      });
    }
    var addArea = $("#addText");
    if (addArea) {
      /* Enter (without Shift) tokenizes — but a newline mid-sentence is fine */
      addArea.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          tokenizeInto((addArea.value || "").trim());
        }
      });
    }

    $("#searchInput").addEventListener("input", function (e) {
      state.search = e.target.value;
      renderLibrary();
    });

    $("#filterChips").addEventListener("click", function (e) {
      var c = e.target.closest(".chip");
      if (!c) return;
      state.filter = c.dataset.filter;
      $$(".chip").forEach(function (x) {
        x.classList.toggle("is-active", x === c);
      });
      renderLibrary();
    });

    $("#lookupAllBtn").addEventListener("click", lookupAllMissing);

    /* settings fields */
    $("#setLang").addEventListener("change", function (e) {
      saveSetting({ lang: e.target.value });
    });
    var trBox = $("#setTrLangs");
    if (trBox) {
      trBox.addEventListener("change", function (e) {
        var input = e.target;
        if (!input || input.type !== "checkbox") return;
        var picked = $$('input[type="checkbox"]', trBox)
          .filter(function (b) {
            return b.checked;
          })
          .map(function (b) {
            return b.value;
          });
        if (picked.length > 3) {
          input.checked = false;
          toast("Pick up to 3 languages", "warn");
          return;
        }
        var patch = { trLangs: picked };
        /* the default explanation language must stay one of the chosen */
        var cur = state.settings.explainIn || "en";
        if (cur !== "en" && picked.indexOf(cur) < 0) patch.explainIn = picked[0] || "en";
        saveSetting(patch).then(function () {
          state.explainFor = "";
          renderTrLangChecks();
          render();
          toast(
            picked.length
              ? "Translating into " + picked.map(langName).join(" · ")
              : "Translations switched off"
          );
        });
      });
    }
    $("#setNewPerDay").addEventListener("change", function (e) {
      var v = parseInt(e.target.value, 10);
      if (isNaN(v) || v < 0) v = 0;
      saveSetting({ newPerDay: v }).then(function () {
        rebuildQueue();
        render();
      });
    });
    $("#setReminder").addEventListener("change", function (e) {
      saveSetting({ reminder: e.target.value });
      toast(e.target.value ? "Reminder set for " + e.target.value : "Reminder switched off");
    });
    $("#setEnabled").addEventListener("change", function (e) {
      saveSetting({ enabled: e.target.checked });
      toast(e.target.checked ? "Click-to-save is on" : "Click-to-save is off");
    });
    $("#setShowHints").addEventListener("change", function (e) {
      saveSetting({ showHints: e.target.checked });
    });
    $("#setTheme").addEventListener("change", function (e) {
      saveSetting({ theme: e.target.value }).then(render);
    });

    /* data */
    $("#exportBtn").addEventListener("click", exportData);
    $("#importBtn").addEventListener("click", function () {
      $("#importFile").click();
    });
    $("#importFile").addEventListener("change", importData);
    $("#resetBtn").addEventListener("click", resetData);

    document.addEventListener("keydown", onKey);
  }

  function setView(v) {
    state.view = v;
    if (v === "today") {
      state.revealed = false;
      if (!state.queue.length || state.idx >= state.queue.length) rebuildQueue();
    }
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function onKey(e) {
    if (state.view !== "today") return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (!state.queue.length || state.idx >= state.queue.length) return;

    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!state.revealed) reveal();
      return;
    }
    if (state.revealed && ["1", "2", "3", "4"].indexOf(e.key) > -1) {
      e.preventDefault();
      grade(FC.GRADES[parseInt(e.key, 10) - 1]);
    }
  }

  /* ------------------------------------------------------------ meaning */
  /** Meaning, phrase and sentences all still need translating for `to`? */
  function needsTranslation(card, to) {
    if (!card || !to || to === "en" || card.translating === to) return false;
    if (!card.translations || !card.translations[to]) return true;
    var list = sentencesOf(card);
    var done = (card.exampleTr && card.exampleTr[to]) || [];
    return list.length > done.length;
  }

  /** Translate — meaning, phrase and every example sentence — into fa/ar. */
  function fetchTranslation(card, to) {
    if (!card || card.translating === to) return;
    var wordText = simpleOf(card.meaning);
    var phrase = card.phrase && card.phrase.meaning ? card.phrase : null;
    var phraseText = phrase ? simpleOf(phrase.meaning) : "";
    var list = sentencesOf(card).slice(0, 4);
    if (!wordText && !phraseText && !list.length) return;
    card.translating = to;

    var jobs = [];
    jobs.push(
      wordText
        ? FC.translate(wordText, to).then(function (t) {
            return { kind: "word", t: t };
          })
        : Promise.resolve(null)
    );
    jobs.push(
      phraseText
        ? FC.translate(phraseText, to).then(function (t) {
            return { kind: "phrase", t: t };
          })
        : Promise.resolve(null)
    );

    Promise.all(jobs)
      .then(function (res) {
        res.forEach(function (r) {
          if (!r || !r.t) return;
          if (r.kind === "word") {
            card.translations = card.translations || {};
            card.translations[to] = r.t;
          } else if (card.phrase) {
            card.phrase.translations = card.phrase.translations || {};
            card.phrase.translations[to] = r.t;
          }
        });
        /* sentences next, one at a time — the free endpoint throttles bursts */
        return translateSentences(list, to).then(function (trs) {
          if (trs && trs.length) {
            card.exampleTr = card.exampleTr || {};
            card.exampleTr[to] = trs;
          }
        });
      })
      .then(function () {
        var live = liveCopy(card);
        if (live && live !== card) {
          live.translations = card.translations;
          live.phrase = card.phrase;
          live.exampleTr = card.exampleTr;
        }
        return FC.saveCard(card).then(function () {
          if (state.explain === to && state.revealed) renderToday();
        });
      })
      .catch(function () {
        toast("Could not reach the translator");
      })
      .then(function () {
        card.translating = "";
      });
  }

  /** Sequential so a card's sentences don't trip the rate limit. */
  function translateSentences(list, to) {
    var out = [];
    var chain = Promise.resolve();
    list.forEach(function (s, i) {
      chain = chain
        .then(function () {
          return FC.translate(s, to);
        })
        .then(
          function (t) {
            out[i] = t || "";
          },
          function () {
            out[i] = "";
          }
        )
        .then(function () {
          return new Promise(function (r) {
            setTimeout(r, 120);
          });
        });
    });
    return chain.then(function () {
      return out;
    });
  }

  function lookupMeaningFor(card, done) {
    FC.lookupMeaning(card.word, state.settings.lang || "en", card.context)
      .then(function (m) {
        if (!m || (!m.meaning && !m.phrase)) {
          toast("No dictionary entry found for “" + card.word + "”");
          if (done) done();
          return null;
        }
        card.meaning = m.meaning;
        card.definitions = m.definitions;
        card.meaningSource = m.source;
        card.example = m.example || card.example || "";
        card.examples = m.examples && m.examples.length ? m.examples : card.examples || null;
        card.phrase = m.phrase || null;
        return FC.saveCard(card).then(function () {
          toast("Meaning added");
          reloadCards().then(function () {
            render();
            if (done) done();
          });
        });
      })
      .catch(function () {
        toast("Could not reach the dictionary");
        if (done) done();
      });
  }

  async function lookupAllMissing() {
    if (state.lookupBusy) return;
    var missing = state.cards.filter(function (c) {
      return !c.meaning;
    });
    if (!missing.length) {
      toast("Every word already has a meaning ✓");
      return;
    }
    state.lookupBusy = true;
    var btn = $("#lookupAllBtn");
    btn.disabled = true;

    var found = 0;
    for (var i = 0; i < missing.length; i++) {
      btn.textContent = "Looking up " + (i + 1) + "/" + missing.length;
      var card = missing[i];
      try {
        var m = await FC.lookupMeaning(card.word, state.settings.lang || "en", card.context);
        if (m && (m.meaning || m.phrase)) {
          card.meaning = m.meaning;
          card.definitions = m.definitions;
          card.meaningSource = m.source;
          card.example = m.example || card.example || "";
          card.examples = m.examples && m.examples.length ? m.examples : card.examples || null;
          card.phrase = m.phrase || null;
          await FC.saveCard(card);
          found++;
        }
      } catch (e) {
        /* keep going */
      }
      await new Promise(function (r) {
        setTimeout(r, 260);
      });
    }

    btn.disabled = false;
    btn.textContent = "Find missing meanings";
    state.lookupBusy = false;
    await reloadCards();
    render();
    toast("Added " + found + " meaning" + (found === 1 ? "" : "s") + " of " + missing.length);
  }

  /* --------------------------------------------------------------- data */
  function exportData() {
    var payload = {
      app: "FluentCards",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      cards: state.cards
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fluentcards-" + FC.dayKey(Date.now()) + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 4000);
    toast("Exported " + state.cards.length + " words");
  }

  function importData(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var data = JSON.parse(reader.result);
        var cards = Array.isArray(data) ? data : data.cards;
        if (!Array.isArray(cards)) throw new Error("no cards");
        var n = await FC.importCards(cards);
        await reloadCards(true);
        render();
        toast("Imported " + n + " words");
      } catch (err) {
        toast("That file is not a FluentCards export");
      }
      $("#importFile").value = "";
    };
    reader.readAsText(file);
  }

  async function resetData() {
    var n = state.cards.length;
    if (!confirm("Erase all " + n + " flashcards and your progress? This cannot be undone."))
      return;
    await FC.resetAll();
    state.settings = await FC.getSettings();
    state.stats = await FC.getStats();
    state.queue = [];
    state.idx = 0;
    state.revealed = false;
    await reloadCards(true);
    applyTheme();
    syncSettingsForm();
    render();
    toast("All data erased");
  }

  /* -------------------------------------------------------------- helpers */
  function toast(msg) {
    var t = $("#appToast");
    t.hidden = false;
    t.textContent = msg;
    requestAnimationFrame(function () {
      t.classList.add("is-show");
    });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("is-show");
      setTimeout(function () {
        t.hidden = true;
      }, 320);
    }, 2500);
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(
      /[&<>"']/g,
      function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      }
    );
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function timeLabel(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
  }

  function highlightContext(text, word) {
    var frag = document.createDocumentFragment();
    text = String(text || "");
    var target = String(word || "").toLowerCase();
    if (!target) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    var lower = text.toLowerCase();
    var i = 0;
    var idx;
    var isWordChar = function (ch) {
      return ch ? /[\p{L}\p{N}]/u.test(ch) : false;
    };
    while ((idx = lower.indexOf(target, i)) !== -1) {
      if (isWordChar(text[idx - 1]) || isWordChar(text[idx + target.length])) {
        i = idx + 1;
        continue;
      }
      frag.appendChild(document.createTextNode(text.slice(i, idx)));
      var mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + target.length);
      frag.appendChild(mark);
      i = idx + target.length;
    }
    frag.appendChild(document.createTextNode(text.slice(i)));
    return frag;
  }

  /* ----------------------------------------------------------------- go */
  boot().catch(function (err) {
    document.body.innerHTML =
      '<p style="padding:40px;font-family:sans-serif">Failed to start: ' +
      esc(err && err.message) +
      "</p>";
  });
})();
