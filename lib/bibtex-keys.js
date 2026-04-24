/**
 * BibTeX citation keys + duplicate detection.
 *
 * Public functions:
 *   parseBibEntries(bibText)      -> [{ type, key, raw, start, end, fields }]
 *   findBibMatch(entries, doc)    -> { key, reason } | null
 *   generateKey(doc, existing,    -> string       (collision-resolved)
 *               { mode, typed })
 *   rewriteBibtexKey(entryText,   -> string       (cite key swapped in place)
 *                    newKey)
 *   ensureUniqueKey(key,          -> string
 *                   existingKeys)
 *
 * Loaded as a content script (attaches API to window.ADS4OL) or as a CJS
 * module in Node tests.
 */
(function (root) {
  'use strict';

  // ----- LaTeX accent / command stripping for ASCII-only key text ----
  function delatex(str) {
    if (!str) return '';
    var out = String(str);
    var specials = [
      ['\\AA','A'], ['\\aa','a'], ['\\O','O'], ['\\o','o'],
      ['\\L','L'], ['\\l','l'], ['\\ss','ss'],
      ['\\ae','ae'], ['\\AE','AE'], ['\\oe','oe'], ['\\OE','OE'],
      ['\\i','i'], ['\\j','j']
    ];
    for (var i = 0; i < specials.length; i++) {
      out = out.split(specials[i][0]).join(specials[i][1]);
    }
    out = out.replace(/\\[`'"^~=.]\s*\{?([A-Za-z])\}?/g, '$1');
    out = out.replace(/\\[vucrH]\s*\{?([A-Za-z])\}?/g, '$1');
    out = out.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1');
    out = out.replace(/\\[a-zA-Z]+\*?\s*/g, '');
    out = out.replace(/[{}]/g, '');
    return out;
  }

  function toAscii(str) {
    try {
      return String(str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
    } catch (_) {
      return String(str || '');
    }
  }

  // ----- Title slug for informative keys --------------------------------
  var SLUG_STOPWORDS = new Set([
    'the','a','an','and','or','but','for','with','of','in','on','at','to',
    'by','from','as','is','are','be','new','using','use','towards','toward',
    'into','onto','upon','via','per'
  ]);

  function titleSlugTokens(title, maxTokens) {
    if (!title) return [];
    var clean = delatex(toAscii(title))
      .replace(/\$[^$]*\$/g, ' ')
      .replace(/[^A-Za-z0-9\s-]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    var tokens = clean.split(/\s+/).filter(function (w) {
      return w.length >= 3 && !SLUG_STOPWORDS.has(w);
    });
    return tokens.slice(0, maxTokens || 2);
  }

  // ----- First author surname ------------------------------------------
  /**
   * Extract first author's surname, ASCII-normalised.
   * Accepts either a raw BibTeX author field ("Smith, J. and Lee, K.") or
   * an ADS-style array of "Last, First" strings.
   */
  function firstAuthorSurname(author) {
    if (!author) return '';
    var first = '';
    if (Array.isArray(author)) {
      first = author[0] || '';
    } else {
      first = String(author).split(/\s+and\s+/i)[0] || '';
    }
    first = String(first).trim();
    if (!first) return '';
    var surname;
    if (first.indexOf(',') !== -1) {
      surname = first.split(',')[0];
    } else {
      var parts = first.split(/\s+/).filter(Boolean);
      surname = parts[parts.length - 1] || '';
    }
    return delatex(toAscii(surname)).replace(/[^A-Za-z]/g, '') || '';
  }

  // ----- Key mode implementations --------------------------------------
  function keyAuthorYear(doc) {
    var s = firstAuthorSurname(doc && doc.author) || 'Citation';
    var y = doc && doc.year != null ? String(doc.year) : '';
    return s + y;
  }

  function keyInformative(doc) {
    var s = firstAuthorSurname(doc && doc.author) || 'Citation';
    var y = doc && doc.year != null ? String(doc.year).slice(-2) : '';
    var slugTokens = titleSlugTokens(doc && doc.title, 2);
    var base = s + y;
    return slugTokens.length ? base + '_' + slugTokens.join('_') : base;
  }

  function keyBibcode(doc) {
    var b = (doc && doc.bibcode ? String(doc.bibcode) : '').trim();
    return b || keyAuthorYear(doc);
  }

  function keyTyped(typed, doc) {
    var raw = String(typed || '').trim();
    // Strip braces/whitespace and anything BibTeX can't use as a key.
    var cleaned = raw.replace(/[\s{}\\]/g, '').replace(/[^A-Za-z0-9_.:+\-]/g, '');
    if (cleaned) return cleaned;
    return keyAuthorYear(doc);
  }

  /**
   * Pick a citation key per the requested mode, then resolve collisions
   * against existingKeys by appending a, b, ..., z, 2, 3, 4, ...
   */
  function generateKey(doc, existingKeys, options) {
    options = options || {};
    var mode = String(options.mode || 'bibcode').toLowerCase();
    var typed = options.typed;
    var base;
    switch (mode) {
      case 'authoryear': base = keyAuthorYear(doc); break;
      case 'informative': base = keyInformative(doc); break;
      case 'typed': base = keyTyped(typed, doc); break;
      case 'bibcode':
      default: base = keyBibcode(doc); break;
    }
    if (!base) base = 'Citation';
    return ensureUniqueKey(base, existingKeys || []);
  }

  function ensureUniqueKey(baseKey, existingKeys) {
    var set = new Set(existingKeys || []);
    if (!set.has(baseKey)) return baseKey;
    var letters = 'abcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i < letters.length; i++) {
      var cand = baseKey + letters[i];
      if (!set.has(cand)) return cand;
    }
    var n = 2;
    while (set.has(baseKey + n)) n++;
    return baseKey + n;
  }

  // ----- BibTeX parsing (brace-aware) ----------------------------------
  function readField(raw, name) {
    // Simple values: name = "..." or name = 12345
    var simpleRe = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|(\\d+)(?!\\.))', 'i');
    var sm = raw.match(simpleRe);
    if (sm) return (sm[1] != null ? sm[1] : sm[2]).trim();
    // Brace value, with proper nesting
    var brRe = new RegExp('\\b' + name + '\\s*=\\s*\\{', 'ig');
    var m = brRe.exec(raw);
    if (!m) return '';
    var start = m.index + m[0].length;
    var depth = 1, i = start;
    while (i < raw.length && depth > 0) {
      var ch = raw[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth !== 0) return '';
    return raw.slice(start, i - 1).trim();
  }

  function extractFieldsFromRaw(raw) {
    return {
      title: readField(raw, 'title'),
      doi: readField(raw, 'doi'),
      adsurl: readField(raw, 'adsurl'),
      eprint: readField(raw, 'eprint'),
      archiveprefix: readField(raw, 'archiveprefix'),
      year: readField(raw, 'year'),
      author: readField(raw, 'author'),
    };
  }

  function bibcodeFromAdsUrl(adsurl) {
    if (!adsurl) return '';
    var m = String(adsurl).match(/\/abs\/([^/?#\s]+)/);
    return m ? m[1] : '';
  }

  /**
   * Parse a BibTeX string into entries with their absolute offsets.
   * Tolerant of garbage outside entries; brace-counts inside the body.
   */
  function parseBibEntries(bibText) {
    var entries = [];
    var text = String(bibText || '');
    var i = 0;
    while (i < text.length) {
      var at = text.indexOf('@', i);
      if (at < 0) break;
      // Scan type up to '{'
      var openBrace = text.indexOf('{', at);
      if (openBrace < 0) break;
      var typeRaw = text.slice(at + 1, openBrace).trim();
      if (!/^[A-Za-z]+$/.test(typeRaw)) {
        // Likely a stray '@', skip past it
        i = at + 1;
        continue;
      }
      // Find comma after key
      var comma = text.indexOf(',', openBrace + 1);
      if (comma < 0) break;
      var key = text.slice(openBrace + 1, comma).trim();
      if (!key) { i = comma + 1; continue; }
      // Brace-match to end
      var depth = 1, p = openBrace + 1;
      while (p < text.length && depth > 0) {
        var ch = text[p];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        p++;
      }
      var end = depth === 0 ? p : text.length;
      var raw = text.slice(at, end);
      entries.push({
        type: typeRaw,
        key: key,
        raw: raw,
        start: at,
        end: end,
        fields: extractFieldsFromRaw(raw),
      });
      i = end;
    }
    return entries;
  }

  // ----- Duplicate detection -------------------------------------------
  function normalizeDoi(s) {
    if (!s) return '';
    return String(s).trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^["{]|["}]$/g, '')
      .toLowerCase();
  }

  function normalizeBibcode(s) {
    return String(s || '').replace(/\./g, '').toLowerCase();
  }

  function normalizeArxivId(s) {
    if (!s) return '';
    var cleaned = String(s).replace(/^arXiv:/i, '').trim().toLowerCase();
    return /^\d{4}\.\d{4,5}$/.test(cleaned) ? cleaned : '';
  }

  function normalizeTitle(s) {
    return delatex(toAscii(s || ''))
      .replace(/\$[^$]*\$/g, ' ')
      .replace(/[^A-Za-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Find an existing entry that matches the candidate paper.
   * Matching priority: DOI > bibcode > arXiv ID > normalised title.
   * Candidate shape: { doi, bibcode, title, eprint?, identifier?[] }.
   */
  function findBibMatch(entries, candidate) {
    if (!entries || !entries.length || !candidate) return null;

    var candDoi = normalizeDoi(candidate.doi);
    if (candDoi) {
      for (var i = 0; i < entries.length; i++) {
        var d = normalizeDoi(entries[i].fields.doi);
        if (d && d === candDoi) return { key: entries[i].key, reason: 'doi' };
      }
    }

    var candBibcode = normalizeBibcode(candidate.bibcode);
    if (candBibcode) {
      for (var j = 0; j < entries.length; j++) {
        var f = entries[j].fields;
        var eBib = normalizeBibcode(f.bibcode || bibcodeFromAdsUrl(f.adsurl));
        if (eBib && eBib === candBibcode) return { key: entries[j].key, reason: 'bibcode' };
        // Also: cite key is a literal bibcode?
        if (normalizeBibcode(entries[j].key) === candBibcode) {
          return { key: entries[j].key, reason: 'bibcode-as-key' };
        }
      }
    }

    // arXiv — candidate can carry eprint or an identifier[] array
    var candArxiv = normalizeArxivId(candidate.eprint);
    if (!candArxiv && Array.isArray(candidate.identifier)) {
      for (var a = 0; a < candidate.identifier.length; a++) {
        var idMatch = String(candidate.identifier[a]).match(/(?:arXiv:)?(\d{4}\.\d{4,5})/i);
        if (idMatch) { candArxiv = idMatch[1].toLowerCase(); break; }
      }
    }
    if (candArxiv) {
      for (var k = 0; k < entries.length; k++) {
        var ent = entries[k];
        var eArxiv = normalizeArxivId(ent.fields.eprint);
        if (eArxiv && eArxiv === candArxiv) return { key: ent.key, reason: 'arxiv' };
      }
    }

    var candTitle = normalizeTitle(candidate.title);
    if (candTitle && candTitle.length >= 12) {
      for (var t = 0; t < entries.length; t++) {
        var eTitle = normalizeTitle(entries[t].fields.title);
        if (eTitle && eTitle === candTitle) return { key: entries[t].key, reason: 'title' };
      }
    }
    return null;
  }

  // ----- Key rewrite in a raw BibTeX entry -----------------------------
  /**
   * Replace the cite key in the first `@type{KEY,` header of entryText.
   * Leaves the rest of the entry untouched.
   */
  function rewriteBibtexKey(entryText, newKey) {
    return String(entryText || '').replace(
      /^(\s*@[A-Za-z]+\s*[{(]\s*)([^,\s{}]+)(\s*,)/,
      function (_, head, _oldKey, tail) { return head + newKey + tail; }
    );
  }

  // ----- Public API ----------------------------------------------------
  var api = {
    parseBibEntries: parseBibEntries,
    findBibMatch: findBibMatch,
    generateKey: generateKey,
    ensureUniqueKey: ensureUniqueKey,
    rewriteBibtexKey: rewriteBibtexKey,
    // Exposed for tests:
    _internal: {
      delatex: delatex,
      firstAuthorSurname: firstAuthorSurname,
      normalizeTitle: normalizeTitle,
      normalizeDoi: normalizeDoi,
      normalizeBibcode: normalizeBibcode,
      normalizeArxivId: normalizeArxivId,
      bibcodeFromAdsUrl: bibcodeFromAdsUrl,
      titleSlugTokens: titleSlugTokens,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.ADS4OL = Object.assign(root.ADS4OL || {}, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
