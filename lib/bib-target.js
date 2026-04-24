/**
 * Bib-target resolver — pure helpers for "which .bib file should we use?"
 *
 * Loaded three ways:
 *   - as a content script, attaching its API to window.ADS4OL
 *   - as a CommonJS module in Node tests (module.exports)
 *   - as-is in the service worker if imported via dynamic import
 */
(function (root) {
  'use strict';

  var CONVENTIONAL_NAMES = ['references.bib', 'refs.bib', 'main.bib', 'bibliography.bib'];

  /**
   * Extract bibliography filenames referenced in a TeX document.
   * Handles \bibliography{a,b}, \addbibresource{c.bib}, extension-less forms.
   */
  function extractBibliographyTargets(texContent) {
    var out = new Set();
    if (!texContent || typeof texContent !== 'string') return [];
    var directives = [
      /\\bibliography\s*\{([^}]+)\}/g,
      /\\addbibresource\s*\{([^}]+)\}/g,
    ];
    for (var i = 0; i < directives.length; i++) {
      var re = directives[i];
      var m;
      while ((m = re.exec(texContent)) !== null) {
        var pieces = m[1].split(',');
        for (var j = 0; j < pieces.length; j++) {
          var name = pieces[j].trim();
          if (!name) continue;
          out.add(name.toLowerCase().endsWith('.bib') ? name : name + '.bib');
        }
      }
    }
    return Array.from(out);
  }

  /**
   * Resolve the bib-file target given the current project state.
   * Returns { status, target, candidates, reason } where
   *   status is 'resolved' | 'needs-choice' | 'not-found'.
   */
  function resolveBibTarget(state) {
    state = state || {};
    var texContent = state.texContent || '';
    var activeFileName = state.activeFileName || '';
    var projectFiles = state.projectFiles || [];
    var projectId = state.projectId || '';
    var overrides = state.overrides || {};

    var bibFiles = dedupe(projectFiles).filter(function (n) { return /\.bib$/i.test(n); });

    if (projectId && typeof overrides[projectId] === 'string') {
      var chosen = overrides[projectId];
      if (bibFiles.indexOf(chosen) !== -1) {
        return { status: 'resolved', target: chosen, candidates: bibFiles, reason: 'override' };
      }
    }

    var directiveTargets = extractBibliographyTargets(texContent);
    if (directiveTargets.length) {
      var hits = directiveTargets.filter(function (n) { return bibFiles.indexOf(n) !== -1; });
      if (hits.length === 1) {
        return { status: 'resolved', target: hits[0], candidates: bibFiles, reason: 'bibliography-directive' };
      }
      if (hits.length > 1) {
        return { status: 'needs-choice', target: null, candidates: hits, reason: 'multiple-directives' };
      }
    }

    if (activeFileName && /\.bib$/i.test(activeFileName)) {
      var bare = basename(activeFileName);
      var hit = bibFiles.indexOf(activeFileName) !== -1
        ? activeFileName
        : bibFiles.find(function (n) { return basename(n) === bare; });
      if (hit) {
        return { status: 'resolved', target: hit, candidates: bibFiles, reason: 'active-bib' };
      }
      return { status: 'resolved', target: activeFileName, candidates: bibFiles, reason: 'active-bib-direct' };
    }

    if (bibFiles.length === 1) {
      return { status: 'resolved', target: bibFiles[0], candidates: bibFiles, reason: 'single-bib' };
    }

    var conventional = bibFiles.filter(function (n) {
      return CONVENTIONAL_NAMES.indexOf(basename(n).toLowerCase()) !== -1;
    });
    if (conventional.length === 1) {
      return { status: 'resolved', target: conventional[0], candidates: bibFiles, reason: 'conventional-name' };
    }

    if (bibFiles.length > 1) {
      return { status: 'needs-choice', target: null, candidates: bibFiles, reason: 'ambiguous' };
    }

    return { status: 'not-found', target: null, candidates: [], reason: 'no-bib-files' };
  }

  function dedupe(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
  }

  function basename(path) {
    var i = String(path).lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
  }

  var api = {
    extractBibliographyTargets: extractBibliographyTargets,
    resolveBibTarget: resolveBibTarget,
  };

  // Node / CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Browser / content script
  if (root && typeof root === 'object') {
    root.ADS4OL = Object.assign(root.ADS4OL || {}, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
