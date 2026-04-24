/**
 * BibTeX to ADS Resolution Logic
 *
 * Resolves BibTeX entries to ADS bibcodes using multiple search strategies:
 * 1. Direct bibcode match (if present in entry)
 * 2. DOI search (most reliable)
 * 3. arXiv ID search (very reliable)
 * 4. Title + Author search (fallback)
 */

import { BibtexUtils } from './shared-import.js';

/**
 * Result of resolving a single BibTeX entry
 */
/**
 * @typedef {Object} ResolutionResult
 * @property {string} citeKey - Original cite key from BibTeX
 * @property {string} entryType - BibTeX entry type
 * @property {string|null} bibcode - Resolved ADS bibcode (null if not found)
 * @property {string} method - How it was resolved: 'bibcode', 'doi', 'arxiv', 'title', or 'not_found'
 * @property {number} confidence - Confidence score 0-1
 * @property {Object} [document] - ADS document if found
 * @property {string} [error] - Error message if resolution failed
 */

/**
 * Resolve a single BibTeX entry to an ADS bibcode
 *
 * @param {Object} entry - Parsed BibTeX entry with citeKey, entryType, fields
 * @param {Function} searchFn - Function to search ADS: (query, rows) => Promise<{documents, numFound}>
 * @returns {Promise<ResolutionResult>} Resolution result
 */
export async function resolveEntry(entry, searchFn) {
  const identifiers = BibtexUtils.extractIdentifiers(entry);
  const result = {
    citeKey: entry.citeKey,
    entryType: entry.entryType,
    bibcode: null,
    method: 'not_found',
    confidence: 0,
    fields: entry.fields,
  };

  try {
    // 1. Direct bibcode match
    if (identifiers.bibcode) {
      const searchResult = await searchFn(`bibcode:"${identifiers.bibcode}"`, 1);
      if (searchResult.numFound === 1) {
        result.bibcode = searchResult.documents[0].bibcode;
        result.method = 'bibcode';
        result.confidence = 1.0;
        result.document = searchResult.documents[0];
        return result;
      }
    }

    // 2. DOI search (most reliable)
    if (identifiers.doi) {
      // Try exact DOI match first
      let searchResult = await searchFn(`doi:"${identifiers.doi}"`, 1);
      if (searchResult.numFound === 1) {
        result.bibcode = searchResult.documents[0].bibcode;
        result.method = 'doi';
        result.confidence = 0.99;
        result.document = searchResult.documents[0];
        return result;
      }
      // Try without quotes as fallback
      searchResult = await searchFn(`doi:${identifiers.doi}`, 1);
      if (searchResult.numFound === 1) {
        result.bibcode = searchResult.documents[0].bibcode;
        result.method = 'doi';
        result.confidence = 0.99;
        result.document = searchResult.documents[0];
        return result;
      }
    }

    // 3. arXiv search (very reliable)
    if (identifiers.arxivId) {
      // Clean arXiv ID - remove any version suffix like "v1"
      const cleanArxivId = identifiers.arxivId.replace(/v\d+$/, '');

      // Try multiple query formats - ADS uses 'identifier' field
      const arxivQueries = [
        `identifier:${cleanArxivId}`,           // Most common format
        `identifier:"${cleanArxivId}"`,         // With quotes
        `arxiv:${cleanArxivId}`,                // Alternative format
        `identifier:arXiv:${cleanArxivId}`,     // Full prefix format
      ];

      for (const query of arxivQueries) {
        try {
          const searchResult = await searchFn(query, 1);
          if (searchResult.numFound >= 1) {
            result.bibcode = searchResult.documents[0].bibcode;
            result.method = 'arxiv';
            result.confidence = 0.98;
            result.document = searchResult.documents[0];
            return result;
          }
        } catch (e) {
          // Continue to next query format
        }
      }
    }

    // 4. Title + Author search (fallback) with progressive relaxation
    const title = entry.fields.title;
    const author = entry.fields.author;
    const year = entry.fields.year;

    if (title && author) {
      // Try tightest query first, then progressively relax. Each attempt is
      // shaped differently to handle a different failure mode:
      //   1) strict — best precision when title+author+year all line up
      //   2) no year — preprints, reprints, cross-year listings (e.g. accepted
      //      year vs publication year mismatch)
      //   3) fewer title words — ADS title may differ in subtitle/wording
      const attempts = [
        buildTitleAuthorQuery(title, author, year, { titleWordLimit: 5 }),
        buildTitleAuthorQuery(title, author, null, { titleWordLimit: 5 }),
        buildTitleAuthorQuery(title, author, null, { titleWordLimit: 3 }),
      ];

      const seen = new Set();
      for (const query of attempts) {
        if (!query || seen.has(query)) continue;
        seen.add(query);
        try {
          const searchResult = await searchFn(query, 5);
          if (searchResult.numFound >= 1) {
            const match = findBestMatch(entry, searchResult.documents);
            if (match) {
              result.bibcode = match.document.bibcode;
              result.method = 'title';
              result.confidence = match.confidence;
              result.document = match.document;
              return result;
            }
          }
        } catch (e) {
          // Try the next (looser) query
        }
      }
    }

    // Not found
    return result;

  } catch (error) {
    result.error = error.message;
    return result;
  }
}

/**
 * Resolve multiple BibTeX entries with progress reporting
 *
 * @param {Array} entries - Array of parsed BibTeX entries
 * @param {Function} searchFn - Search function
 * @param {Function} [onProgress] - Progress callback: (current, total, result) => void
 * @param {number} [delayMs=100] - Delay between requests to avoid rate limiting
 * @returns {Promise<Array<ResolutionResult>>} Array of resolution results
 */
export async function resolveEntries(entries, searchFn, onProgress, delayMs = 100) {
  const results = [];

  for (let i = 0; i < entries.length; i++) {
    const result = await resolveEntry(entries[i], searchFn);
    results.push(result);

    if (onProgress) {
      onProgress(i + 1, entries.length, result);
    }

    // Delay between requests to avoid rate limiting
    if (i < entries.length - 1 && delayMs > 0) {
      await delay(delayMs);
    }
  }

  return results;
}

/**
 * Resolve multiple BibTeX entries in parallel with bounded concurrency.
 *
 * Throughput comes from the rate limiter in ads-api.js (10 req/s); this just
 * keeps enough in-flight to saturate it. Results are returned in input order.
 *
 * @param {Array} entries - Parsed BibTeX entries
 * @param {Function} searchFn - Search function (query, rows) => Promise
 * @param {Object} [options]
 * @param {number} [options.concurrency=5] - Max in-flight resolutions
 * @param {Function} [options.onProgress] - (completed, total, result) => void
 * @returns {Promise<Array<ResolutionResult>>}
 */
export async function resolveEntriesParallel(entries, searchFn, options = {}) {
  const { concurrency = 5, onProgress } = options;
  const results = new Array(entries.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= entries.length) return;
      results[i] = await resolveEntry(entries[i], searchFn);
      completed++;
      if (onProgress) {
        onProgress(completed, entries.length, results[i]);
      }
    }
  }

  const workerCount = Math.min(concurrency, entries.length);
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

/**
 * Batched resolver — the API-cheap path.
 *
 * Instead of one ADS call per entry, this:
 *   1. Triages entries into groups by identifier (bibcode / DOI / arXiv / none).
 *   2. Resolves each identifier group with a small number of OR-batched
 *      Solr queries (default 100 identifiers per query).
 *   3. Falls back to per-entry title+author search (which has to stay
 *      one-at-a-time) for anything that had no identifier and for identifier
 *      entries that the batch call didn't find.
 *
 * Typical reduction for a 2 800-entry .bib: ~8 000 queries → ~1 000 queries
 * (roughly one per title-only entry, plus ~15 batch queries for everything
 * with a DOI / bibcode / arXiv ID).
 *
 * searchFn signature: (query, rows) => Promise<{ documents, numFound }>
 *
 * @param {Array} entries - Normalised entries with { citeKey, entryType, fields }
 * @param {Function} searchFn
 * @param {Object} [options]
 * @param {number} [options.batchSize=100] - Identifiers per OR-batch query
 * @param {number} [options.titleConcurrency=4] - Parallel title+author lookups
 * @param {Function} [options.onProgress] - (completed, total, result) => void
 * @returns {Promise<Array<ResolutionResult>>}
 */
export async function resolveEntriesBatched(entries, searchFn, options = {}) {
  const { batchSize = 100, titleConcurrency = 4, onProgress } = options;

  const results = entries.map(e => ({
    citeKey: e.citeKey,
    entryType: e.entryType,
    bibcode: null,
    method: 'not_found',
    confidence: 0,
    fields: e.fields,
  }));

  let completed = 0;
  const tick = (idx) => {
    completed++;
    if (onProgress) onProgress(completed, entries.length, results[idx]);
  };

  // Triage entries by available identifier. An entry might have multiple; we
  // route each one to the highest-precision batch it qualifies for.
  const byBibcode = new Map();  // bibcode -> [entry indexes]
  const byDoi = new Map();
  const byArxiv = new Map();
  const titleOnly = [];

  for (let i = 0; i < entries.length; i++) {
    const ids = BibtexUtils.extractIdentifiers(entries[i]);
    if (ids.bibcode) {
      pushMulti(byBibcode, ids.bibcode, i);
    } else if (ids.doi) {
      pushMulti(byDoi, ids.doi.toLowerCase(), i);
    } else if (ids.arxivId) {
      pushMulti(byArxiv, ids.arxivId.replace(/v\d+$/, ''), i);
    } else {
      titleOnly.push(i);
    }
  }

  // ---- Batch 1: bibcode lookups ----
  await batchResolve({
    keys: Array.from(byBibcode.keys()),
    indexesFor: k => byBibcode.get(k),
    buildQuery: (chunk) => `bibcode:(${chunk.map(b => `"${escapeSolr(b)}"`).join(' OR ')})`,
    docMatches: (doc) => [doc.bibcode].filter(Boolean),
    method: 'bibcode',
    confidence: 1.0,
    searchFn, batchSize, results, tick,
  });

  // ---- Batch 2: DOI lookups ----
  await batchResolve({
    keys: Array.from(byDoi.keys()),
    indexesFor: k => byDoi.get(k),
    buildQuery: (chunk) => `doi:(${chunk.map(d => `"${escapeSolr(d)}"`).join(' OR ')})`,
    docMatches: (doc) => (Array.isArray(doc.doi) ? doc.doi : [doc.doi]).filter(Boolean).map(x => String(x).toLowerCase()),
    method: 'doi',
    confidence: 0.99,
    searchFn, batchSize, results, tick,
  });

  // ---- Batch 3: arXiv lookups via identifier field ----
  await batchResolve({
    keys: Array.from(byArxiv.keys()),
    indexesFor: k => byArxiv.get(k),
    buildQuery: (chunk) => `identifier:(${chunk.map(a => `"${escapeSolr(a)}"`).join(' OR ')})`,
    docMatches: (doc) => {
      const ids = Array.isArray(doc.identifier) ? doc.identifier : [];
      const out = [];
      for (const raw of ids) {
        const m = String(raw).match(/(\d{4}\.\d{4,5})/);
        if (m) out.push(m[1]);
      }
      return out;
    },
    method: 'arxiv',
    confidence: 0.98,
    searchFn, batchSize, results, tick,
  });

  // ---- Fallback: title+author for anything still unresolved ----
  const remaining = titleOnly.slice();
  for (const [, idxs] of byBibcode) {
    for (const i of idxs) if (!results[i].bibcode) remaining.push(i);
  }
  for (const [, idxs] of byDoi) {
    for (const i of idxs) if (!results[i].bibcode) remaining.push(i);
  }
  for (const [, idxs] of byArxiv) {
    for (const i of idxs) if (!results[i].bibcode) remaining.push(i);
  }

  // Dedupe and preserve order of first occurrence.
  const seen = new Set();
  const uniqueRemaining = remaining.filter(i => {
    if (seen.has(i)) return false;
    seen.add(i);
    return true;
  });

  // Parallel title+author search (still one query per entry — no way to
  // batch fuzzy title matching across papers).
  let nextIdx = 0;
  async function titleWorker() {
    while (true) {
      const cursor = nextIdx++;
      if (cursor >= uniqueRemaining.length) return;
      const i = uniqueRemaining[cursor];
      try {
        const single = await resolveEntryTitleOnly(entries[i], searchFn);
        // If the batch calls already stamped a result (because identifier
        // hit), don't overwrite that — otherwise merge title-only outcome.
        if (!results[i].bibcode && single.bibcode) {
          Object.assign(results[i], single);
        } else if (!results[i].bibcode) {
          results[i].method = single.method;
          results[i].confidence = single.confidence;
          if (single.error) results[i].error = single.error;
        }
      } catch (e) {
        results[i].error = e.message || String(e);
      }
      tick(i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(titleConcurrency, uniqueRemaining.length); w++) {
    workers.push(titleWorker());
  }
  await Promise.all(workers);

  return results;
}

// ---- Batch helpers -----------------------------------------------------

function pushMulti(map, key, value) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function escapeSolr(value) {
  // Escape Solr phrase-query terminators inside our quoted strings.
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function batchResolve(ctx) {
  const { keys, indexesFor, buildQuery, docMatches, method, confidence, searchFn, batchSize, results, tick } = ctx;
  if (!keys.length) return;

  for (let offset = 0; offset < keys.length; offset += batchSize) {
    const chunk = keys.slice(offset, offset + batchSize);
    let searchResult;
    try {
      searchResult = await searchFn(buildQuery(chunk), Math.min(chunk.length * 2, 2000));
    } catch (_) {
      // Surface failure as "not_found" for every entry in this chunk;
      // callers can fall back to title+author.
      for (const k of chunk) {
        const idxs = indexesFor(k) || [];
        for (const i of idxs) tick(i);
      }
      continue;
    }
    const matched = new Set();
    const docs = (searchResult && searchResult.documents) || [];
    for (const doc of docs) {
      const matchKeys = docMatches(doc) || [];
      for (const k of matchKeys) {
        if (matched.has(k)) continue;
        const idxs = indexesFor(k);
        if (!idxs) continue;
        matched.add(k);
        for (const i of idxs) {
          if (results[i].bibcode) continue;
          results[i].bibcode = doc.bibcode;
          results[i].method = method;
          results[i].confidence = confidence;
          results[i].document = doc;
          tick(i);
        }
      }
    }
    // Any key in chunk that didn't match still counts toward progress — its
    // entries will be routed to the title+author fallback below.
    for (const k of chunk) {
      if (matched.has(k)) continue;
      const idxs = indexesFor(k) || [];
      for (const i of idxs) {
        if (!results[i].bibcode) {
          // Progress ticks for these happen in the title-only fallback.
        }
      }
    }
  }
}

// Single-entry title+author path — no identifier retries.
async function resolveEntryTitleOnly(entry, searchFn) {
  const result = {
    citeKey: entry.citeKey,
    entryType: entry.entryType,
    bibcode: null,
    method: 'not_found',
    confidence: 0,
    fields: entry.fields,
  };
  const title = entry.fields && entry.fields.title;
  const author = entry.fields && entry.fields.author;
  const year = entry.fields && entry.fields.year;
  if (!title || !author) return result;

  // Two relaxation tiers only. Trimmed from three to lower per-entry cost
  // now that batch queries take care of identifier-bearing entries.
  const attempts = [
    buildTitleAuthorQuery(title, author, year, { titleWordLimit: 5 }),
    buildTitleAuthorQuery(title, author, null, { titleWordLimit: 4 }),
  ];
  const seen = new Set();
  for (const query of attempts) {
    if (!query || seen.has(query)) continue;
    seen.add(query);
    try {
      const searchResult = await searchFn(query, 5);
      if (searchResult.numFound >= 1) {
        const match = findBestMatch(entry, searchResult.documents);
        if (match) {
          result.bibcode = match.document.bibcode;
          result.method = 'title';
          result.confidence = match.confidence;
          result.document = match.document;
          return result;
        }
      }
    } catch (_) { /* try next */ }
  }
  return result;
}

// Common English / academic stopwords. Dropping these keeps the
// distinctive-word budget for content-bearing terms.
const TITLE_STOPWORDS = new Set([
  'the','and','for','with','from','into','onto','that','this','these','those',
  'their','our','its','are','was','were','been','being','have','has','had',
  'can','may','might','would','could','should','upon','over','under','between',
  'among','within','without','via','not','but','also','how','why','what','when',
  'where','who','which','one','two','three','four','five','any','all','some',
  'here','there','new','using','use','used','based','towards','toward','due',
  'per','about','after','before','during','through','than','then','such',
  'will','shall','does','did','do','does','non','etc',
]);

/**
 * Convert common LaTeX accent macros to plain ASCII.
 * Handles: \'e, \`e, \"u, \^o, \~n, \=a, \.z, \v{s}, \u{g}, \c{c}, \H{o},
 * \r{a}, and the special commands \AA \aa \O \o \L \l \ss \ae \AE \oe \OE.
 * Falls through on unknown commands by stripping them.
 */
function delatex(str) {
  if (!str) return '';
  let out = str;

  // Bare special letters (no braces): {\AA}, {\aa}, etc.
  const specials = [
    ['\\AA','A'], ['\\aa','a'],
    ['\\O','O'],  ['\\o','o'],
    ['\\L','L'],  ['\\l','l'],
    ['\\ss','ss'],
    ['\\ae','ae'], ['\\AE','AE'],
    ['\\oe','oe'], ['\\OE','OE'],
    ['\\i','i'],   ['\\j','j'],
  ];
  for (const [k, v] of specials) {
    out = out.split(k).join(v);
  }

  // Accent macros: \'{e} or \'e → e ; \v{s} or \vs → s ; etc.
  // Covers punctuation accents and letter-command accents.
  out = out.replace(/\\[`'"^~=.]\s*\{?([A-Za-z])\}?/g, '$1');
  out = out.replace(/\\[vucrH]\s*\{?([A-Za-z])\}?/g, '$1');

  // Any remaining \command{arg} → keep arg
  out = out.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1');
  // Any remaining \command → drop
  out = out.replace(/\\[a-zA-Z]+\s*/g, '');
  // Remove stray braces
  out = out.replace(/[{}]/g, '');
  return out;
}

/**
 * Extract the first author's surname, normalised to plain ASCII.
 * BibTeX author format is "Last, First and Last, First and ..." but we also
 * tolerate the "First Last" shorthand that bibliographies sometimes use.
 */
function extractFirstAuthorSurname(authorField) {
  if (!authorField) return '';
  const first = authorField.split(/\s+and\s+/i)[0].trim();
  let surname;
  if (first.includes(',')) {
    surname = first.split(',')[0];
  } else {
    // "First Last" — take the last whitespace-separated token.
    const tokens = first.split(/\s+/).filter(Boolean);
    surname = tokens[tokens.length - 1] || '';
  }
  return delatex(surname).trim();
}

/**
 * Sanitise a title into a list of distinctive keywords safe for Solr.
 * Strips LaTeX, drops punctuation that Solr treats specially, removes
 * stopwords, and caps length.
 */
function titleKeywords(title, limit) {
  if (!title) return [];
  const cleaned = delatex(title)
    .replace(/\$[^$]*\$/g, ' ')       // inline math
    .replace(/[^A-Za-z0-9\s-]/g, ' ') // drop Solr-special punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const words = cleaned
    .split(/\s+/)
    .filter(w =>
      w.length >= 4 &&
      /[a-z]/.test(w) &&
      !TITLE_STOPWORDS.has(w)
    );

  // De-duplicate while preserving order
  const seen = new Set();
  const unique = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }
  return unique.slice(0, limit);
}

/**
 * Build a title + author ADS query.
 *
 * @param {string} title
 * @param {string} author
 * @param {string|null|undefined} year
 * @param {Object} [options]
 * @param {number} [options.titleWordLimit=5]
 * @returns {string} ADS query string (empty string if nothing usable)
 */
function buildTitleAuthorQuery(title, author, year, options = {}) {
  const { titleWordLimit = 5 } = options;
  const words = titleKeywords(title, titleWordLimit);
  const surname = extractFirstAuthorSurname(author);

  const parts = [];
  if (words.length > 0) {
    parts.push(`title:(${words.join(' ')})`);
  }
  if (surname) {
    parts.push(`author:"${surname}"`);
  }
  if (year && /^\d{4}$/.test(String(year).trim())) {
    parts.push(`year:${String(year).trim()}`);
  }
  return parts.join(' ');
}

/**
 * Find the best matching document from search results
 *
 * @param {Object} entry - BibTeX entry
 * @param {Array} documents - ADS documents from search
 * @returns {Object|null} Best match with confidence, or null
 */
function findBestMatch(entry, documents) {
  const entryTitle = normalizeTitle(entry.fields.title || '');
  const entryYear = entry.fields.year;

  let bestMatch = null;
  let bestScore = 0;

  for (const doc of documents) {
    const docTitle = normalizeTitle(
      Array.isArray(doc.title) ? doc.title[0] : doc.title || ''
    );

    // Calculate title similarity (simple Jaccard similarity)
    const similarity = calculateTitleSimilarity(entryTitle, docTitle);

    // Year match bonus
    let score = similarity;
    if (entryYear && doc.year && parseInt(entryYear) === doc.year) {
      score += 0.1;
    }

    if (score > bestScore && similarity > 0.5) {
      bestScore = score;
      bestMatch = {
        document: doc,
        confidence: Math.min(similarity, 0.9), // Cap at 0.9 for title matches
      };
    }
  }

  return bestMatch;
}

/**
 * Normalize a title for comparison (used by Jaccard best-match).
 */
function normalizeTitle(title) {
  return delatex(title || '')
    .toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')       // inline math
    .replace(/[^a-z0-9\s]/g, ' ')     // keep only alphanumerics + space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate title similarity using word-based Jaccard similarity
 */
function calculateTitleSimilarity(title1, title2) {
  const words1 = new Set(title1.split(' ').filter(w => w.length > 2));
  const words2 = new Set(title2.split(' ').filter(w => w.length > 2));

  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Simple delay function
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Categorize resolution results
 *
 * @param {Array<ResolutionResult>} results - Resolution results
 * @returns {Object} Categorized results
 */
export function categorizeResults(results) {
  const found = results.filter(r => r.bibcode !== null);
  const notFound = results.filter(r => r.bibcode === null);
  const errors = results.filter(r => r.error);

  return {
    found,
    notFound,
    errors,
    stats: {
      total: results.length,
      foundCount: found.length,
      notFoundCount: notFound.length,
      errorCount: errors.length,
      byMethod: {
        bibcode: found.filter(r => r.method === 'bibcode').length,
        doi: found.filter(r => r.method === 'doi').length,
        arxiv: found.filter(r => r.method === 'arxiv').length,
        title: found.filter(r => r.method === 'title').length,
      },
    },
  };
}
