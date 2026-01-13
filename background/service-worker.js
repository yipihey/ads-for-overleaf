/**
 * Background Service Worker
 * Handles ADS API requests and message passing
 */

// ES Module imports from shared library
import { ADSClient, ADSError, Storage, BibtexUtils } from '../lib/shared-import.js';
import { resolveEntries, categorizeResults } from '../lib/bibtex-resolver.js';

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
  const result = await client.addToLibrary(libraryId, bibcodes);

  // Clear cache for this library
  await Storage.remove([`libDocs_${libraryId}`, `libDocsTime_${libraryId}`]);

  return result;
}

/**
 * Create a new ADS library
 * @param {string} name - Library name
 * @param {Object} options - Optional settings (description, bibcodes, isPublic)
 */
async function createLibrary(name, options = {}) {
  const client = await getClient();
  const result = await client.createLibrary(name, options);

  // Clear libraries cache so the new library shows up
  await Storage.remove(['libraries', 'librariesTime']);

  return result;
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

  // Convert parsed entries to format expected by resolver
  // The parseBibtex adapter returns { type, key, raw } format for compatibility
  // We need to convert to { citeKey, entryType, fields } format
  const normalizedEntries = entries.map(entry => ({
    citeKey: entry.key,
    entryType: entry.type,
    fields: extractFieldsFromRaw(entry.raw),
  }));

  // Create search function wrapper
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
