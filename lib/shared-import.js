/**
 * Shared Library Integration
 *
 * This file provides integration with shared-ads-lib.
 * It wraps the shared library APIs to maintain backwards compatibility
 * with the existing ads-for-overleaf codebase.
 *
 * SETUP REQUIRED:
 * The shared library must be copied into the extension directory:
 *
 * Option 1 - Symlink (for development):
 *   cd ads-for-overleaf/lib
 *   ln -s ../../shared-ads-lib/dist/esm shared-ads-lib
 *
 * Option 2 - Copy (for distribution):
 *   cp -r shared-ads-lib/dist/esm ads-for-overleaf/lib/shared-ads-lib
 *
 * To rebuild shared-ads-lib:
 *   cd shared-ads-lib && npm install && npm run build
 */

// Import from shared-ads-lib (must be in lib/shared-ads-lib/)
import {
  ADSClient as SharedADSClient,
  ADSError as SharedADSError,
  DEFAULT_ADS_RATE_LIMIT,
  generateCiteKey,
  makeKeyUnique,
  getFirstAuthorLastName,
  formatAuthors as sharedFormatAuthors,
  formatShortCitation as sharedFormatShortCitation,
  formatCiteCommand,
  formatMultipleCitations,
  getJournalAbbrev as sharedGetJournalAbbrev,
  parseBibtex as sharedParseBibtex,
  extractIdentifiers,
  containsKey,
  escapeRegex,
  mergeBibtex as sharedMergeBibtex,
  paperToBibtex,
  formatEntry,
  validateEntry,
} from './shared-ads-lib/index.js';

// Re-export Storage from local implementation (browser-specific)
export { Storage, CACHE_CONFIG } from './storage.js';

// Rate limit config (for backwards compatibility)
export const RATE_LIMIT = DEFAULT_ADS_RATE_LIMIT;

// ============================================================================
// ADSClient Adapter
// ============================================================================

/**
 * ADSClient adapter that wraps the shared library client
 * to maintain backwards compatibility with existing code.
 *
 * Key differences handled:
 * - Constructor takes token string instead of config object
 * - getLibraries returns raw ADS format (num_documents instead of numDocuments)
 * - getLibraryDocuments returns { documents, numFound } instead of { papers, total }
 * - search returns { documents, numFound } instead of { papers, numFound }
 */
class ADSClient {
  constructor(token) {
    this._client = new SharedADSClient({ token });
  }

  /**
   * Validate the API token
   */
  async validateToken() {
    return this._client.validateToken();
  }

  /**
   * Get all user libraries (returns ADS format for backwards compatibility)
   */
  async getLibraries() {
    const libraries = await this._client.getLibraries();
    // Convert back to ADS format for backwards compatibility
    return libraries.map(lib => ({
      id: lib.id,
      name: lib.name,
      description: lib.description,
      num_documents: lib.numDocuments,
      date_created: lib.dateCreated,
      date_last_modified: lib.dateModified,
      public: lib.isPublic,
      owner: lib.owner,
    }));
  }

  /**
   * Get contents of a specific library
   */
  async getLibrary(libraryId) {
    const result = await this._client.getLibrary(libraryId);
    return {
      documents: result.bibcodes,
      metadata: result.metadata,
    };
  }

  /**
   * Get library documents with full metadata
   * Returns { documents, numFound } format for backwards compatibility
   */
  async getLibraryDocuments(libraryId, start = 0, rows = 100) {
    const result = await this._client.getLibraryDocuments(libraryId, { start, rows });
    return {
      documents: result.papers.map(paperToAdsDoc),
      numFound: result.total,
    };
  }

  /**
   * Sanitize a bibcode to prevent query injection
   */
  sanitizeBibcode(bibcode) {
    return this._client.sanitizeBibcode(bibcode);
  }

  /**
   * Get documents by bibcode
   */
  async getDocumentsByBibcode(bibcodes) {
    const result = await this._client.getDocumentsByBibcode(bibcodes);
    return {
      documents: result.papers.map(paperToAdsDoc),
      numFound: result.numFound,
    };
  }

  /**
   * Search ADS
   * Returns { documents, numFound } format for backwards compatibility
   */
  async search(query, rows = 20, start = 0, sort = 'date desc') {
    const result = await this._client.search(query, { rows, start, sort });
    return {
      documents: result.papers.map(paperToAdsDoc),
      numFound: result.numFound,
    };
  }

  /**
   * Export to BibTeX
   */
  async exportBibtex(bibcodes, options = {}) {
    const {
      keyFormat = null,
      maxAuthor = 10,
      authorCutoff = 200,
      journalFormat = 1,
    } = options;

    return this._client.exportBibtex(bibcodes, {
      keyFormat: keyFormat || 'bibcode',
      maxAuthors: maxAuthor,
      authorCutoff,
      journalFormat,
    });
  }

  /**
   * Add papers to a library
   */
  async addToLibrary(libraryId, bibcodes) {
    return this._client.addToLibrary(libraryId, bibcodes);
  }

  /**
   * Create a new library
   * @param {string} name - Library name
   * @param {Object} options - Optional settings
   * @param {string} options.description - Library description
   * @param {string[]} options.bibcodes - Initial bibcodes to add
   * @param {boolean} options.isPublic - Whether library is public
   * @returns {Object} Created library with id, name, description, numDocuments
   */
  async createLibrary(name, options = {}) {
    const result = await this._client.createLibrary(name, options);
    // Convert to ADS format for backwards compatibility
    return {
      id: result.id,
      name: result.name,
      description: result.description,
      num_documents: result.numDocuments,
      public: result.isPublic,
    };
  }
}

/**
 * Convert a Paper object back to ADS document format
 * for backwards compatibility with existing code
 */
function paperToAdsDoc(paper) {
  return {
    bibcode: paper.bibcode,
    title: [paper.title],
    author: paper.authors,
    year: paper.year,
    pub: paper.venue,
    abstract: paper.abstract,
    doi: paper.doi ? [paper.doi] : undefined,
    identifier: buildIdentifiers(paper),
    citation_count: paper.citationCount,
    read_count: paper.readCount,
    // Include original raw response if available
    ...(paper.rawResponse || {}),
  };
}

/**
 * Build identifier array from Paper
 */
function buildIdentifiers(paper) {
  const identifiers = [];
  if (paper.doi) identifiers.push(`doi:${paper.doi}`);
  if (paper.arxivId) identifiers.push(`arXiv:${paper.arxivId}`);
  if (paper.bibcode) identifiers.push(paper.bibcode);
  return identifiers;
}

// ============================================================================
// ADSError (re-export)
// ============================================================================

const ADSError = SharedADSError;

// ============================================================================
// BibtexUtils Adapter
// ============================================================================

/**
 * BibtexUtils adapter that wraps shared library functions
 * to maintain backwards compatibility with the existing API.
 *
 * The original BibtexUtils worked with ADS document objects directly.
 * The shared library functions work with individual parameters.
 * This adapter bridges that gap.
 */
const BibtexUtils = {
  /**
   * Generate a citation key from document metadata
   */
  generateKey(doc, format = 'bibcode') {
    // Convert ADS doc format to shared library format
    const paper = {
      authors: doc.author || [],
      year: doc.year,
      bibcode: doc.bibcode,
    };
    return generateCiteKey(paper, format);
  },

  /**
   * Make a citation key unique within a set
   */
  makeKeyUnique(key, existingKeys) {
    return makeKeyUnique(key, existingKeys);
  },

  /**
   * Extract first author's last name
   */
  getFirstAuthorLastName(doc) {
    // Handle both doc object and authors array
    const authors = Array.isArray(doc) ? doc : (doc.author || []);
    return getFirstAuthorLastName(authors);
  },

  /**
   * Get journal abbreviation from bibcode
   */
  getJournalAbbrev(doc) {
    return sharedGetJournalAbbrev(doc);
  },

  /**
   * Format authors for display
   */
  formatAuthors(authors, maxAuthors = 3) {
    // Handle both array and options object
    const authorList = Array.isArray(authors) ? authors : [];
    const max = typeof maxAuthors === 'number' ? maxAuthors : 3;
    return sharedFormatAuthors(authorList, { max });
  },

  /**
   * Format a short citation string
   */
  formatShortCitation(doc) {
    const paper = {
      authors: doc.author || [],
      year: doc.year,
    };
    return sharedFormatShortCitation(paper);
  },

  /**
   * Format a citation command
   */
  formatCiteCommand(bibcode, command = '\\cite') {
    return formatCiteCommand(bibcode, command);
  },

  /**
   * Format multiple citations
   */
  formatMultipleCitations(bibcodes, command = '\\cite') {
    return formatMultipleCitations(bibcodes, command);
  },

  /**
   * Parse a BibTeX string and extract entries
   * Returns format compatible with existing code
   */
  parseBibtex(bibtexString) {
    const entries = sharedParseBibtex(bibtexString);
    // Convert to original format for backwards compatibility
    // Use original rawBibtex to preserve all fields
    return entries.map(entry => ({
      type: entry.entryType,
      key: entry.citeKey,
      raw: entry.rawBibtex || formatEntry(entry),
    }));
  },

  /**
   * Check if a BibTeX string contains a specific key
   */
  containsKey(bibtexString, key) {
    return containsKey(bibtexString, key);
  },

  /**
   * Escape special regex characters
   */
  escapeRegex(string) {
    return escapeRegex(string);
  },

  /**
   * Merge new BibTeX entries with existing content
   */
  mergeBibtex(existing, newEntries) {
    return sharedMergeBibtex(existing, newEntries);
  },

  /**
   * Convert a Paper to BibTeX entry
   */
  paperToBibtex(paper) {
    return paperToBibtex(paper);
  },

  /**
   * Validate a BibTeX entry
   */
  validateEntry(entry) {
    return validateEntry(entry);
  },

  /**
   * Extract identifiers (DOI, arXiv, bibcode) from a parsed BibTeX entry
   * @param {Object} entry - Parsed BibTeX entry with citeKey, entryType, and fields
   * @returns {Object} Object with doi, arxivId, bibcode (undefined if not found)
   */
  extractIdentifiers(entry) {
    return extractIdentifiers(entry);
  },
};

// ============================================================================
// Exports
// ============================================================================

export {
  ADSClient,
  ADSError,
  BibtexUtils,
  // Also export individual functions for direct use
  generateCiteKey,
  makeKeyUnique,
  getFirstAuthorLastName,
  formatCiteCommand,
  formatMultipleCitations,
  extractIdentifiers,
  containsKey,
  escapeRegex,
  paperToBibtex,
  formatEntry,
  validateEntry,
};
