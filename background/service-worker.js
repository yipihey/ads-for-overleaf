/**
 * Background Service Worker
 * Handles ADS API requests and message passing
 */

// ES Module imports from shared library
import { ADSClient, ADSError, Storage, BibtexUtils } from '../lib/shared-import.js';
import { resolveEntries, resolveEntriesParallel, resolveEntriesBatched, categorizeResults } from '../lib/bibtex-resolver.js';

// Max bibcodes per addToLibrary POST. ADS accepts large bodies in one call
// today, but chunking is cheap insurance for imports in the thousands.
const ADD_TO_LIBRARY_CHUNK = 500;

// Concurrency for resolveBibtexChunk workers. Kept under the 10 req/s rate
// limiter so the limiter, not this value, governs throughput.
const RESOLVE_CONCURRENCY = 5;

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => sendResponse({ error: error.message }));
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  const { action, payload } = message;

  switch (action) {
    case 'validateToken':
      return await validateToken(payload.token);

    case 'getLibraries':
      return await getLibraries(payload?.forceRefresh);

    case 'getLibraryDocuments':
      return await getLibraryDocuments(payload.libraryId, payload.forceRefresh);

    case 'search':
      return await search(payload.query, payload.rows, payload.start);

    case 'exportBibtex':
      return await exportBibtex(payload.bibcodes, payload.options);

    case 'addToLibrary':
      return await addToLibrary(payload.libraryId, payload.bibcodes);

    case 'createLibrary':
      return await createLibrary(payload.name, payload.options);

    case 'resolveBibtex':
      return await resolveBibtex(payload.bibtexContent);

    case 'parseBibtex':
      return parseBibtexEntries(payload.bibtexContent);

    case 'resolveBibtexChunk':
      return await resolveBibtexChunk(payload.entries);

    case 'getPreferences':
      return await Storage.getPreferences();

    case 'setPreferences':
      await Storage.setPreferences(payload);
      return { success: true };

    case 'clearCaches':
      await Storage.clearCaches();
      return { success: true };

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Get an authenticated ADS client
 */
async function getClient() {
  const token = await Storage.getToken();
  if (!token) {
    throw new Error('ADS API token not configured. Please set your token in the extension options.');
  }
  return new ADSClient(token);
}

/**
 * Validate an API token
 */
async function validateToken(token) {
  const client = new ADSClient(token);
  const result = await client.validateToken();
  
  if (result.valid) {
    await Storage.setToken(token);
  }
  
  return result;
}

/**
 * Get user's ADS libraries
 */
async function getLibraries(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await Storage.getCachedLibraries();
    if (cached) {
      return { libraries: cached, fromCache: true };
    }
  }

  const client = await getClient();
  const libraries = await client.getLibraries();
  
  await Storage.setCachedLibraries(libraries);
  
  return { libraries, fromCache: false };
}

/**
 * Get documents from a library
 */
async function getLibraryDocuments(libraryId, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await Storage.getCachedLibraryDocs(libraryId);
    if (cached) {
      return { documents: cached, fromCache: true };
    }
  }

  const client = await getClient();
  // Fetch up to 3000 documents to support large libraries
  const result = await client.getLibraryDocuments(libraryId, 0, 3000);

  await Storage.setCachedLibraryDocs(libraryId, result.documents);

  return { documents: result.documents, fromCache: false };
}

/**
 * Search ADS
 */
async function search(query, rows = 20, start = 0) {
  const client = await getClient();
  return await client.search(query, rows, start);
}

/**
 * Export bibcodes to BibTeX
 */
async function exportBibtex(bibcodes, options = {}) {
  const client = await getClient();
  const bibtex = await client.exportBibtex(bibcodes, options);
  return { bibtex };
}

/**
 * Add papers to a library
 */
async function addToLibrary(libraryId, bibcodes) {
  const client = await getClient();

  if (bibcodes.length <= ADD_TO_LIBRARY_CHUNK) {
    const result = await client.addToLibrary(libraryId, bibcodes);
    await Storage.remove([`libDocs_${libraryId}`, `libDocsTime_${libraryId}`]);
    return result;
  }

  let addedCount = 0;
  let lastResult = null;
  for (let i = 0; i < bibcodes.length; i += ADD_TO_LIBRARY_CHUNK) {
    const chunk = bibcodes.slice(i, i + ADD_TO_LIBRARY_CHUNK);
    lastResult = await client.addToLibrary(libraryId, chunk);
    if (lastResult && typeof lastResult.number_added === 'number') {
      addedCount += lastResult.number_added;
    }
  }

  await Storage.remove([`libDocs_${libraryId}`, `libDocsTime_${libraryId}`]);

  return { ...(lastResult || {}), number_added: addedCount };
}

/**
 * Create a new ADS library
 * @param {string} name - Library name
 * @param {Object} options - Optional settings (description, bibcodes, isPublic)
 */
async function createLibrary(name, options = {}) {
  const client = await getClient();
  const allBibcodes = Array.isArray(options && options.bibcodes) ? options.bibcodes.slice() : [];

  // Create the library with at most ADD_TO_LIBRARY_CHUNK bibcodes in the
  // initial POST. One huge POST can exceed the MV3 service-worker idle
  // window and make the message port close before sendResponse fires;
  // chunking keeps each round-trip short.
  const initialBibcodes = allBibcodes.slice(0, ADD_TO_LIBRARY_CHUNK);
  const rest = allBibcodes.slice(ADD_TO_LIBRARY_CHUNK);

  const createOpts = Object.assign({}, options || {}, { bibcodes: initialBibcodes });
  const result = await client.createLibrary(name, createOpts);

  // Invalidate libraries cache up front so callers re-fetch.
  await Storage.remove(['libraries', 'librariesTime']);

  let totalAdded = initialBibcodes.length;

  if (rest.length && result && result.id) {
    for (let i = 0; i < rest.length; i += ADD_TO_LIBRARY_CHUNK) {
      const chunk = rest.slice(i, i + ADD_TO_LIBRARY_CHUNK);
      const addRes = await client.addToLibrary(result.id, chunk);
      if (addRes && typeof addRes.number_added === 'number') {
        totalAdded = Math.max(totalAdded, initialBibcodes.length + (i + addRes.number_added));
      } else {
        totalAdded = initialBibcodes.length + i + chunk.length;
      }
    }
    await Storage.remove([`libDocs_${result.id}`, `libDocsTime_${result.id}`]);
  }

  return Object.assign({}, result, { number_added: totalAdded, numDocuments: totalAdded });
}

/**
 * Resolve BibTeX entries to ADS bibcodes
 * @param {string} bibtexContent - Raw BibTeX content
 * @returns {Object} Resolution results with found/notFound categorization
 */
async function resolveBibtex(bibtexContent) {
  const client = await getClient();

  // Parse BibTeX content
  const entries = BibtexUtils.parseBibtex(bibtexContent);

  if (entries.length === 0) {
    return {
      results: [],
      categorized: {
        found: [],
        notFound: [],
        errors: [],
        stats: { total: 0, foundCount: 0, notFoundCount: 0, errorCount: 0, byMethod: {} },
      },
    };
  }

  const normalizedEntries = entries.map(normalizeParsedEntry);

  const searchFn = async (query, rows) => {
    return await client.search(query, rows);
  };

  // Resolve entries
  const results = await resolveEntries(normalizedEntries, searchFn, null, 150);

  // Categorize results
  const categorized = categorizeResults(results);

  return { results, categorized };
}

/**
 * Parse a raw BibTeX string into normalised entries for chunked resolution.
 * Fast, no network. Lets the content script drive resolution in chunks.
 * @param {string} bibtexContent
 * @returns {{ entries: Array<{citeKey: string, entryType: string, fields: Object}> }}
 */
function parseBibtexEntries(bibtexContent) {
  const parsed = BibtexUtils.parseBibtex(bibtexContent);
  const entries = parsed.map(normalizeParsedEntry);
  return { entries };
}

/**
 * Resolve a chunk of already-normalised entries in parallel.
 * Kept small enough per call that the SW returns well within the MV3 idle
 * window; the content script loops and aggregates.
 * @param {Array} entries - Normalised entries from parseBibtexEntries
 * @returns {Promise<{results: Array}>}
 */
async function resolveBibtexChunk(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { results: [] };
  }

  // Persistent cache: keyed by identifier, valid across import runs. Every
  // cache hit is an ADS query we don't have to make.
  const cache = await Storage.getResolutionCache();
  const cacheHits = new Array(entries.length).fill(null);
  const toQueryIdx = [];
  const toQueryEntries = [];

  for (let i = 0; i < entries.length; i++) {
    const key = cacheKeyForEntry(entries[i]);
    if (key && cache[key]) {
      const cached = cache[key];
      cacheHits[i] = {
        citeKey: entries[i].citeKey,
        entryType: entries[i].entryType,
        fields: entries[i].fields,
        bibcode: cached.bibcode || null,
        method: cached.method || (cached.bibcode ? 'cache' : 'not_found'),
        confidence: typeof cached.confidence === 'number' ? cached.confidence : (cached.bibcode ? 0.95 : 0),
        fromCache: true,
      };
    } else {
      toQueryIdx.push(i);
      toQueryEntries.push(entries[i]);
    }
  }

  const results = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    if (cacheHits[i]) results[i] = cacheHits[i];
  }

  if (toQueryEntries.length === 0) {
    return { results };
  }

  const client = await getClient();
  const searchFn = async (query, rows) => {
    return await client.search(query, rows);
  };

  // Use the batched resolver: ~15 ADS calls for a chunk of 100 entries that
  // all have DOIs, vs. 100+ calls with the per-entry path. Title-only
  // entries still fall through to single-entry fuzzy search.
  const freshResults = await resolveEntriesBatched(toQueryEntries, searchFn, {
    batchSize: 100,
    titleConcurrency: RESOLVE_CONCURRENCY,
  });

  // Stitch fresh results into the final array by original index.
  const cacheAdditions = {};
  for (let k = 0; k < freshResults.length; k++) {
    const i = toQueryIdx[k];
    results[i] = freshResults[k];
    if (freshResults[k].bibcode) {
      const key = cacheKeyForEntry(entries[i]);
      if (key) {
        cacheAdditions[key] = {
          bibcode: freshResults[k].bibcode,
          method: freshResults[k].method,
          confidence: freshResults[k].confidence,
        };
      }
    }
  }
  if (Object.keys(cacheAdditions).length) {
    // Fire-and-forget — failures here shouldn't block the import.
    Storage.mergeResolutionCache(cacheAdditions).catch(() => {});
  }

  return { results };
}

function normalizeParsedEntry(entry) {
  return {
    citeKey: entry.key,
    entryType: entry.type,
    fields: extractFieldsFromRaw(entry.raw),
  };
}

/**
 * Stable cache key for a normalised BibTeX entry. Prefers the strongest
 * identifier available, falling back to a fingerprint of title + first
 * author + year for title-only entries (which we still have to query fuzzy
 * but can at least memoise across runs).
 */
function cacheKeyForEntry(entry) {
  const ids = BibtexUtils.extractIdentifiers(entry);
  if (ids.bibcode) return 'bibcode:' + ids.bibcode.toLowerCase();
  if (ids.doi) return 'doi:' + ids.doi.toLowerCase();
  if (ids.arxivId) return 'arxiv:' + ids.arxivId.replace(/v\d+$/, '').toLowerCase();
  const f = entry.fields || {};
  const title = (f.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
  const author = (f.author || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  const year = (f.year || '').toString().trim();
  if (title && author && year) return 'titleAuth:' + title + '|' + author + '|' + year;
  return null;
}

/**
 * Extract fields from raw BibTeX string
 * @param {string} rawBibtex - Raw BibTeX entry
 * @returns {Object} Extracted fields
 */
function extractFieldsFromRaw(rawBibtex) {
  const fields = {};

  // First try simple fields without nested braces
  const simpleFieldRegex = /(\w+)\s*=\s*(?:"([^"]*)"|(\d+)(?![.\d]))/g;
  let match;
  while ((match = simpleFieldRegex.exec(rawBibtex)) !== null) {
    const fieldName = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? '';
    fields[fieldName] = value.trim();
  }

  // Now handle brace-delimited fields with proper brace matching
  const braceFieldRegex = /(\w+)\s*=\s*\{/g;
  while ((match = braceFieldRegex.exec(rawBibtex)) !== null) {
    const fieldName = match[1].toLowerCase();
    const startPos = match.index + match[0].length;

    // Find matching closing brace
    let braceCount = 1;
    let pos = startPos;
    while (pos < rawBibtex.length && braceCount > 0) {
      if (rawBibtex[pos] === '{') braceCount++;
      else if (rawBibtex[pos] === '}') braceCount--;
      pos++;
    }

    if (braceCount === 0) {
      const value = rawBibtex.substring(startPos, pos - 1);
      fields[fieldName] = value.trim();
    }
  }

  return fields;
}

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-citation-picker') {
    // Send message to active Overleaf tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url?.includes('overleaf.com')) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'openCitationPicker' });
      }
    });
  }
});

// Handle extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open options page on first install
    chrome.runtime.openOptionsPage();
  }
});

console.log('ADS for Overleaf service worker initialized');
