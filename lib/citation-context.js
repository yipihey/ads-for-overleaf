/**
 * Citation context — pure helpers that turn "editor text + cursor" into ADS
 * queries, and rerank results by overlap with the surrounding prose.
 *
 * Loaded three ways:
 *   - as a content script, attaching its API to window.ADS4OL
 *   - as a CommonJS module in Node tests (module.exports)
 *   - via dynamic import in a module context
 */
(function (root) {
  'use strict';

  // Stopword list for keyword extraction. Deliberately broad — we're
  // selecting distinctive content words to send to ADS.
  var STOPWORDS = new Set([
    'the','and','for','with','from','into','onto','that','this','these','those',
    'their','they','them','our','its','are','was','were','been','being','have',
    'has','had','can','may','might','would','could','should','upon','over',
    'under','between','among','within','without','via','not','but','also',
    'how','why','what','when','where','who','which','one','two','three','four',
    'five','any','all','some','here','there','new','using','use','used','based',
    'towards','toward','due','per','about','after','before','during','through',
    'than','then','such','will','shall','does','did','non','etc','let','many',
    'show','shows','showed','show','paper','papers','author','authors','work',
    'works','found','finds','find','study','studies','results','result','recent',
    'recently','however','therefore','because','both','either','neither','much',
    'more','most','less','least','very','just','only','same','still','while',
    'whose','whom','whether','rather','often','generally','typically','respectively',
    'between','along','above','below','further','furthermore','moreover','thus',
    'hence','indeed','example','examples','well','known','several','various',
    'different','similar','common','simple','complex','present','previous',
    'current','particular','specific','general','main','major','minor',
  ]);

  // Cite commands we recognise when walking back from the cursor.
  var CITE_CMDS = [
    '\\cite', '\\citep', '\\citet', '\\citeauthor', '\\citeyear',
    '\\parencite', '\\textcite', '\\autocite', '\\footcite', '\\nocite',
    '\\cite*', '\\citep*', '\\citet*'
  ];

  /**
   * Minimal LaTeX accent/command stripper. Keeps body letters from macros
   * like \'e, \v{s}, {\AA}. Enough for keyword-level tokenisation.
   */
  function delatex(str) {
    if (!str) return '';
    var out = String(str);
    var specials = [
      ['\\AA','A'], ['\\aa','a'], ['\\O','O'], ['\\o','o'],
      ['\\L','L'], ['\\l','l'], ['\\ss','ss'],
      ['\\ae','ae'], ['\\AE','AE'], ['\\oe','oe'], ['\\OE','OE'],
      ['\\i','i'], ['\\j','j'],
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

  /**
   * Normalise text to a space-separated lowercase string of letters/digits.
   * Used before keyword extraction and overlap scoring.
   */
  function normalize(text) {
    return delatex(text || '')
      .replace(/\$[^$]*\$/g, ' ')       // inline math
      .replace(/%.*$/gm, ' ')            // TeX comments
      // Split hyphen-separated compounds ("grid-based" -> "grid based"), then
      // drop everything non-word. Keeping hyphens would break Solr queries
      // like title:(grid-based OR foo), which reads "-based" as a negation.
      .replace(/-/g, ' ')
      .replace(/[^A-Za-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Tokenise normalised text into distinctive keywords.
   */
  function tokenize(normalizedText, opts) {
    opts = opts || {};
    var minLen = opts.minLen || 4;
    var limit = opts.limit || 12;
    var words = normalizedText.split(/\s+/).filter(function (w) {
      return w.length >= minLen && /[a-z]/.test(w) && !STOPWORDS.has(w);
    });
    var seen = new Set();
    var unique = [];
    for (var i = 0; i < words.length; i++) {
      if (!seen.has(words[i])) { seen.add(words[i]); unique.push(words[i]); }
    }
    return unique.slice(0, limit);
  }

  /**
   * Find the sentence containing `pos` within `text`. Sentence boundaries
   * are `.` `?` `!` (followed by whitespace) or paragraph breaks.
   */
  function sentenceAround(text, pos) {
    if (!text) return '';
    var n = text.length;
    pos = Math.max(0, Math.min(n, pos | 0));
    var left = pos;
    while (left > 0) {
      var ch = text[left - 1];
      if ((ch === '.' || ch === '?' || ch === '!') && /\s/.test(text[left] || ' ')) break;
      if (left > 1 && ch === '\n' && text[left - 2] === '\n') break;
      left--;
    }
    var right = pos;
    while (right < n) {
      var c = text[right];
      if ((c === '.' || c === '?' || c === '!') && /\s|$/.test(text[right + 1] || ' ')) { right++; break; }
      if (c === '\n' && text[right + 1] === '\n') break;
      right++;
    }
    return text.slice(left, right).trim();
  }

  /**
   * Find the paragraph containing `pos`. Bounded by blank lines or LaTeX
   * structural commands (\section{...}, \begin{...}, \end{...}).
   */
  function paragraphAround(text, pos) {
    if (!text) return '';
    var n = text.length;
    pos = Math.max(0, Math.min(n, pos | 0));
    var paraBreak = /\n\s*\n|\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end)\b/;
    var before = text.slice(0, pos);
    var after = text.slice(pos);
    var beforeMatch = null;
    var m;
    var re1 = new RegExp(paraBreak.source, 'g');
    while ((m = re1.exec(before)) !== null) beforeMatch = m;
    var startIdx = beforeMatch ? beforeMatch.index + beforeMatch[0].length : 0;
    var re2 = new RegExp(paraBreak.source);
    var afterMatch = re2.exec(after);
    var endIdx = afterMatch ? pos + afterMatch.index : n;
    return text.slice(startIdx, endIdx).trim();
  }

  /**
   * If the cursor sits inside a cite command, return the typed token
   * (everything between `{` and the cursor).
   */
  function typedCiteToken(text, pos) {
    if (!text) return '';
    var n = text.length;
    pos = Math.max(0, Math.min(n, pos | 0));
    // Walk back to the nearest '{' not preceded by \\ (a bare opener).
    var i = pos - 1;
    while (i >= 0 && text[i] !== '{' && text[i] !== '}' && text[i] !== '\n') i--;
    if (i < 0 || text[i] !== '{') return '';
    // See if a cite command precedes the brace.
    var lookback = text.slice(Math.max(0, i - 30), i);
    var cmdRe = /\\[A-Za-z]+\*?\s*(\[[^\]]*\])?\s*$/;
    var cmdMatch = lookback.match(cmdRe);
    if (!cmdMatch) return '';
    var cmdStart = cmdMatch[0];
    var cmdName = (cmdStart.match(/^\\[A-Za-z]+\*?/) || [''])[0];
    if (CITE_CMDS.indexOf(cmdName) === -1) return '';
    return text.slice(i + 1, pos).trim();
  }

  /**
   * Extract surname+year hint from a typed cite token like "Smith2020" or
   * "smith2020".
   */
  function parseTypedToken(token) {
    var surname = '';
    var year = '';
    if (!token) return { surname: '', year: '' };
    var m = String(token).match(/^([A-Za-z][A-Za-z'\-]{1,})\s*(\d{4})$/);
    if (m) { surname = m[1]; year = m[2]; return { surname: surname, year: year }; }
    var s = String(token).match(/^([A-Za-z][A-Za-z'\-]{2,})$/);
    if (s) return { surname: s[1], year: '' };
    var y = String(token).match(/^(\d{4})$/);
    if (y) return { surname: '', year: y[1] };
    return { surname: '', year: '' };
  }

  /**
   * Main extractor. Returns context object ready for query building.
   */
  function extractCitationContext(text, cursorFrom) {
    var sentence = sentenceAround(text || '', cursorFrom || 0);
    var paragraph = paragraphAround(text || '', cursorFrom || 0);
    var typedToken = typedCiteToken(text || '', cursorFrom || 0);
    var hint = parseTypedToken(typedToken);
    // Prefer sentence keywords; fall back to paragraph if too sparse.
    var sentenceKws = tokenize(normalize(sentence), { limit: 8 });
    var keywords = sentenceKws.slice();
    if (keywords.length < 3) {
      var paraKws = tokenize(normalize(paragraph), { limit: 10 });
      for (var i = 0; i < paraKws.length && keywords.length < 8; i++) {
        if (keywords.indexOf(paraKws[i]) === -1) keywords.push(paraKws[i]);
      }
    }
    return {
      sentence: sentence,
      paragraph: paragraph,
      typedToken: typedToken,
      hint: hint,
      keywords: keywords,
    };
  }

  // ------------------------------------------------------------------
  // Query building
  // ------------------------------------------------------------------

  // Solr/Lucene specials we scrub (not escape — our tokens are simple).
  function cleanTerm(term) {
    return String(term).replace(/["()\[\]{}^~*?:\\\/+\-!&|]/g, ' ').trim();
  }

  /**
   * Build an ordered list of ADS query strings from the context.
   * First queries are broader (higher recall), later ones tighter.
   * Empty queries are omitted; callers run them in order.
   */
  function buildContextQueries(ctx) {
    var queries = [];
    if (!ctx || !ctx.keywords || ctx.keywords.length === 0) return queries;

    var kw = ctx.keywords.map(cleanTerm).filter(Boolean);
    if (!kw.length) return queries;

    var broad = kw.slice(0, 6);
    var narrow = kw.slice(0, 4);

    var hintSurname = ctx.hint && ctx.hint.surname ? cleanTerm(ctx.hint.surname) : '';
    var hintYear = ctx.hint && ctx.hint.year ? ctx.hint.year : '';

    var hintClause = '';
    if (hintSurname) hintClause += ' author:"' + hintSurname + '"';
    if (hintYear) hintClause += ' year:' + hintYear;

    // Q1: broad OR across title + abstract (high recall, reranked locally).
    var or = broad.join(' OR ');
    queries.push('(title:(' + or + ') OR abstract:(' + or + '))' + hintClause);

    // Q2: narrower AND across title (high precision).
    if (narrow.length >= 2) {
      queries.push('title:(' + narrow.join(' ') + ')' + hintClause);
    }

    // Q3: typed-hint-only fallback (author + year with no text).
    if (hintSurname && hintYear) {
      queries.push('author:"' + hintSurname + '" year:' + hintYear);
    }
    return queries;
  }

  // ------------------------------------------------------------------
  // Rerank
  // ------------------------------------------------------------------

  function rerankByContext(docs, ctx) {
    if (!Array.isArray(docs) || docs.length === 0) return docs || [];
    var kws = (ctx && ctx.keywords) ? ctx.keywords : [];
    if (kws.length === 0) return docs.slice();

    var kwSet = new Set(kws);
    var scored = docs.map(function (doc) {
      var titleText = Array.isArray(doc.title) ? doc.title[0] : (doc.title || '');
      var abstractText = doc.abstract || '';
      var titleNorm = normalize(titleText);
      var abstractNorm = normalize(abstractText);
      var titleTokens = new Set(titleNorm.split(/\s+/).filter(Boolean));
      var abstractTokens = new Set(abstractNorm.split(/\s+/).filter(Boolean));

      var matched = [];
      var titleHits = 0;
      var abstractHits = 0;
      kws.forEach(function (w) {
        if (titleTokens.has(w)) { titleHits++; matched.push(w); }
        else if (abstractTokens.has(w)) { abstractHits++; matched.push(w); }
      });

      var cites = Number(doc.citation_count || 0);
      var score = titleHits * 2 + abstractHits + Math.log10(cites + 1);
      return { doc: doc, score: score, matched: matched };
    });

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.map(function (s) {
      return Object.assign({}, s.doc, {
        __matchScore: s.score,
        __matchedKeywords: s.matched,
      });
    });
  }

  var api = {
    extractCitationContext: extractCitationContext,
    buildContextQueries: buildContextQueries,
    rerankByContext: rerankByContext,
    // Exposed for tests:
    _internal: {
      normalize: normalize,
      tokenize: tokenize,
      sentenceAround: sentenceAround,
      paragraphAround: paragraphAround,
      typedCiteToken: typedCiteToken,
      parseTypedToken: parseTypedToken,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.ADS4OL = Object.assign(root.ADS4OL || {}, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
