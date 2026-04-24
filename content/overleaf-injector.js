/**
 * Overleaf Content Script
 * Injects the ADS sidebar and citation picker into Overleaf
 */

(function() {
  'use strict';

  // Only run on actual project pages (not the project list)
  // Project URLs look like: /project/64f1234567890abcdef12345
  const projectMatch = window.location.pathname.match(/^\/project\/([a-f0-9]{24})$/i);
  if (!projectMatch) {
    console.log('ADS for Overleaf: Not a project editor page, skipping initialization');
    return;
  }

  // Prevent multiple injections
  if (window.adsForOverleafInjected) return;
  window.adsForOverleafInjected = true;

  // State
  let state = {
    libraries: [],
    currentLibrary: null,
    documents: [],
    searchResults: [],
    isLoading: false,
    error: null,
    preferences: null,
    sidebarVisible: false,
    currentBibFile: null, // Name of currently open .bib file (if any)
    isScrollCollecting: false, // True during scroll-based content collection
    librarySearchQuery: '', // Current search/filter query for library view
  };

  // DOM Elements
  let sidebar = null;
  let toggleButton = null;

  /**
   * Initialize the extension
   */
  async function init() {
    console.log('ADS for Overleaf: Initializing...');

    try {
      // Wait for Overleaf editor to load (with timeout)
      await waitForEditor();

      // Create UI elements
      createToggleButton();
      createSidebar();

      // Load preferences (non-critical, use defaults on failure)
      try {
        state.preferences = await sendMessage({ action: 'getPreferences' });
      } catch (prefError) {
        console.warn('ADS for Overleaf: Could not load preferences, using defaults');
        state.preferences = {
          defaultLibrary: null,
          bibtexKeyFormat: null,
          citeCommand: '\\cite',
          maxAuthors: 10,
          journalFormat: 1
        };
      }

      // Load libraries (non-critical, can be done later)
      try {
        await loadLibraries();
      } catch (libError) {
        console.warn('ADS for Overleaf: Could not load libraries:', libError.message);
        setError('Could not load libraries. Check your API token in settings.');
      }

      // Listen for messages from background
      chrome.runtime.onMessage.addListener(handleMessage);

      console.log('ADS for Overleaf: Ready');
    } catch (error) {
      console.error('ADS for Overleaf: Initialization failed:', error);
      // Create minimal UI to show error state
      createErrorBanner(error.message);
    }
  }

  /**
   * Create an error banner when initialization fails
   */
  function createErrorBanner(message) {
    const banner = document.createElement('div');
    banner.id = 'ads-error-banner';
    banner.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: #fee;
      border: 1px solid #f00;
      border-radius: 4px;
      padding: 10px 15px;
      z-index: 10000;
      font-family: sans-serif;
      font-size: 13px;
      color: #900;
      max-width: 300px;
    `;
    banner.innerHTML = `
      <strong>ADS for Overleaf Error</strong><br>
      ${escapeHtml(message)}<br>
      <button onclick="this.parentElement.remove()" style="margin-top:5px;cursor:pointer;">Dismiss</button>
    `;
    document.body.appendChild(banner);
  }

  /**
   * Wait for Overleaf editor to be ready (with timeout)
   */
  function waitForEditor(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = () => {
        const editor = document.querySelector('.editor-container, .cm-content, .ace_editor');
        if (editor) {
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          reject(new Error('Timed out waiting for Overleaf editor to load'));
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * Send message to background script
   */
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  // =====================================================================
  // Page bridge — lets us read/write the active CodeMirror 6 editor from
  // the isolated content-script world. The bridge script runs in the
  // page's main world and talks back via custom events.
  // =====================================================================
  let bridgeReady = null;
  function ensurePageBridge() {
    if (bridgeReady) return bridgeReady;
    bridgeReady = new Promise((resolve, reject) => {
      try {
        const existing = document.querySelector('script[data-ads4ol-bridge]');
        if (!existing) {
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('content/page-bridge.js');
          s.dataset.ads4olBridge = '1';
          s.async = false;
          s.onerror = () => reject(new Error('Failed to load page bridge'));
          (document.head || document.documentElement).appendChild(s);
          s.onload = () => s.remove();
        }
        // Probe until ping succeeds or time out (~2s).
        const start = Date.now();
        const probe = () => {
          bridgeRequest('ping', null, 300)
            .then(() => resolve(true))
            .catch(() => {
              if (Date.now() - start > 2000) reject(new Error('Page bridge did not answer'));
              else setTimeout(probe, 50);
            });
        };
        probe();
      } catch (err) {
        reject(err);
      }
    });
    return bridgeReady;
  }

  function bridgeRequest(action, payload, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let done = false;
      const onResponse = (ev) => {
        const d = ev && ev.detail;
        if (!d || d.id !== id) return;
        cleanup();
        if (d.ok) resolve(d.result);
        else reject(new Error(d.error || 'Bridge error'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Bridge timeout: ' + action));
      }, timeoutMs);
      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('ads4ol:response', onResponse);
      }
      window.addEventListener('ads4ol:response', onResponse);
      window.dispatchEvent(new CustomEvent('ads4ol:request', {
        detail: { id, action, payload }
      }));
    });
  }

  // =====================================================================
  // Project file + active-file discovery (DOM scrapers, isolated world)
  // =====================================================================
  const PROJECT_FILE_RE = /([A-Za-z0-9_.\-\/ ]+\.(?:tex|bib|sty|cls|bst|bbl|txt|md|csv|json|yaml|yml))\b/i;

  function getProjectId() {
    const m = window.location.pathname.match(/\/project\/([a-f0-9]{24})/i);
    return m ? m[1] : '';
  }

  function collectProjectFiles() {
    const names = new Set();
    const selectors = [
      '[role="treeitem"]',
      '.file-tree [class*="item"]',
      '.file-tree li',
      '[data-testid*="file-tree"] *',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 120) continue;
        const m = text.match(PROJECT_FILE_RE);
        if (m) names.add(m[1].trim());
      }
    }
    return Array.from(names);
  }

  function readActiveFileNameFromDom() {
    const selectors = [
      '.ol-cm-breadcrumbs',
      '.ol-cm-toolbar-wrapper',
      '[role="tab"][aria-selected="true"]',
      '[role="tab"][data-active="true"]',
      '.file-tab.active',
      '.file-tree [aria-selected="true"]',
      '.file-tree .selected',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const direct = (el.textContent || '').replace(/\s+/g, ' ').trim().match(PROJECT_FILE_RE);
      if (direct) return direct[1].trim();
      const matches = [];
      for (const node of el.querySelectorAll('*')) {
        const m = (node.textContent || '').replace(/\s+/g, ' ').trim().match(PROJECT_FILE_RE);
        if (m) matches.push(m[1].trim());
      }
      if (matches.length) {
        matches.sort((a, b) => a.length - b.length);
        return matches[0];
      }
    }
    return '';
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForActiveFile(targetName, timeoutMs = 3500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = readActiveFileNameFromDom();
      if (active && (active === targetName || active.endsWith(targetName) || active.includes(targetName))) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  /**
   * Click a file in the project file tree to switch the active editor.
   * Resolves when the breadcrumb/tab reports the new file, rejects on timeout.
   */
  async function openProjectFile(fileName) {
    if (!fileName) throw new Error('openProjectFile: missing fileName');
    const active = readActiveFileNameFromDom();
    if (active === fileName || active.endsWith('/' + fileName)) return; // already open

    const candidates = [];
    const entrySelectors = [
      '[role="treeitem"]',
      '.file-tree [class*="item"]',
      '.file-tree li',
      '[data-testid*="file-tree"] [role="button"]',
      '[data-testid*="file-tree"] button',
      '[data-testid*="file-tree"] a',
    ];
    const base = fileName.toLowerCase();
    for (const sel of entrySelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (text && (text === base || text.endsWith('/' + base) || text.includes(' ' + base) || text === base)) {
          candidates.push(el);
        }
      }
    }
    if (!candidates.length) {
      // Fall back: any element whose trimmed text ends with the filename.
      for (const el of document.querySelectorAll('span, div, button, a')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (text === base && el.offsetParent) candidates.push(el);
      }
    }
    if (!candidates.length) {
      throw new Error('Could not find "' + fileName + '" in the project file tree.');
    }

    let lastErr = null;
    for (const el of candidates.slice(0, 4)) {
      try {
        el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.click();
        if (await waitForActiveFile(fileName, 3500)) return;
      } catch (e) { lastErr = e; }
      await sleep(150);
    }
    throw lastErr || new Error('Failed to switch to ' + fileName);
  }

  /**
   * Build project state for resolveBibTarget.
   * texContent is the active editor's text (if the user is in a .tex it's
   * what we scan for \bibliography{}).
   */
  async function buildProjectState() {
    let activeEditor = null;
    try {
      await ensurePageBridge();
      activeEditor = await bridgeRequest('getActiveEditor', null, 4000);
    } catch (_) { /* falls back to empty state */ }
    const prefs = state.preferences || (await sendMessage({ action: 'getPreferences', payload: {} }));
    return {
      texContent: activeEditor?.text || '',
      activeFileName: (activeEditor && activeEditor.fileName) || readActiveFileNameFromDom(),
      projectFiles: collectProjectFiles(),
      projectId: getProjectId(),
      overrides: (prefs && prefs.bibFileOverrides) || {},
    };
  }

  async function saveBibFileOverride(projectId, bibFileName) {
    if (!projectId || !bibFileName) return;
    const prefs = state.preferences || (await sendMessage({ action: 'getPreferences', payload: {} }));
    const next = { ...(prefs.bibFileOverrides || {}), [projectId]: bibFileName };
    await sendMessage({ action: 'setPreferences', payload: { bibFileOverrides: next } });
    state.preferences = { ...prefs, bibFileOverrides: next };
  }

  /**
   * High-level wrapper: resolve the target .bib, switch to it, read it,
   * optionally write it, switch back. Guarantees we attempt to restore the
   * original active file on error.
   *
   * @param {(bibText: string, ctx: { target: string }) => Promise<string|null>} fn
   *   Callback receives bib text; returns new bib text to write, or null/undefined
   *   if read-only.
   * @param {Object} [opts]
   * @param {(candidates: string[]) => Promise<string|null>} [opts.pickOnAmbiguous]
   *   Called when resolveBibTarget returns 'needs-choice'. Must resolve to the
   *   chosen filename, or null to abort.
   * @returns {Promise<{ target: string, originalFile: string, wrote: boolean }>}
   */
  async function withBibFile(fn, opts = {}) {
    if (!window.ADS4OL || typeof window.ADS4OL.resolveBibTarget !== 'function') {
      throw new Error('bib-target module not loaded');
    }
    await ensurePageBridge();

    const projState = await buildProjectState();
    let resolution = window.ADS4OL.resolveBibTarget(projState);

    if (resolution.status === 'needs-choice') {
      if (!opts.pickOnAmbiguous) {
        throw new Error('Multiple .bib files in project — pick one first.');
      }
      const chosen = await opts.pickOnAmbiguous(resolution.candidates);
      if (!chosen) throw new Error('Import cancelled.');
      await saveBibFileOverride(projState.projectId, chosen);
      resolution = { status: 'resolved', target: chosen, candidates: resolution.candidates, reason: 'user-picked' };
    }
    if (resolution.status === 'not-found') {
      throw new Error('No .bib file found in this project.');
    }

    const originalFile = projState.activeFileName;
    const target = resolution.target;
    const needsSwitch = !originalFile || !(originalFile === target || originalFile.endsWith('/' + target) || originalFile.endsWith(target));

    try {
      if (needsSwitch) {
        await openProjectFile(target);
        await sleep(150); // let CM settle
      }
      const editor = await bridgeRequest('getActiveEditor', null, 4000);
      const bibText = editor.text;

      const newText = await fn(bibText, { target });
      let wrote = false;

      if (typeof newText === 'string' && newText !== bibText) {
        await bridgeRequest('replaceDocument', {
          text: newText,
          expectedFileName: target,
          expectedLength: bibText.length,
          expectedHead: bibText.slice(0, 200),
          expectedTail: bibText.slice(-200),
        }, 10000);
        wrote = true;
      }
      return { target, originalFile, wrote };
    } finally {
      const returnToSource = state.preferences?.returnToSourceAfterBib !== false;
      if (needsSwitch && returnToSource && originalFile && originalFile !== target) {
        try { await openProjectFile(originalFile); } catch (_) { /* best-effort */ }
      }
    }
  }

  /**
   * Handle messages from background script
   */
  function handleMessage(message, sender, sendResponse) {
    if (message.action === 'openCitationPicker') {
      showSidebar();
      focusSearch();
    }
  }

  /**
   * Create the toggle button in Overleaf toolbar
   */
  function createToggleButton() {
    toggleButton = document.createElement('button');
    toggleButton.id = 'ads-toggle-button';
    toggleButton.className = 'ads-toggle-btn';
    toggleButton.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
      <span>ADS</span>
    `;
    toggleButton.title = 'Toggle ADS Panel (Ctrl+Shift+C)';
    toggleButton.addEventListener('click', toggleSidebar);

    // Find toolbar and insert button
    const insertButton = () => {
      const toolbar = document.querySelector('.toolbar-right, .editor-toolbar');
      if (toolbar) {
        toolbar.insertBefore(toggleButton, toolbar.firstChild);
      } else {
        // Fallback: fixed position
        toggleButton.classList.add('ads-toggle-fixed');
        document.body.appendChild(toggleButton);
      }
    };

    insertButton();
  }

  /**
   * Create the sidebar panel
   */
  function createSidebar() {
    sidebar = document.createElement('div');
    sidebar.id = 'ads-sidebar';
    sidebar.className = 'ads-sidebar';
    sidebar.setAttribute('role', 'complementary');
    sidebar.setAttribute('aria-label', 'NASA ADS Citation Panel');
    sidebar.innerHTML = `
      <div class="ads-sidebar-header">
        <h2 id="ads-panel-title">ADS Libraries</h2>
        <button class="ads-close-btn" title="Close panel" aria-label="Close ADS panel">&times;</button>
      </div>

      <div class="ads-bib-actions" id="ads-bib-actions">
        <button id="ads-import-bib-btn" class="ads-action-btn"
                title="Import entries from current .bib file to an ADS library">
          <span class="ads-btn-icon">+</span> Import .bib to ADS
        </button>
        <button id="ads-sync-to-bib-btn" class="ads-action-btn"
                title="Add missing papers from selected library to .bib file">
          <span class="ads-btn-icon">↓</span> Add to .bib
        </button>
      </div>

      <div class="ads-search-container" role="search">
        <label for="ads-search-input" class="visually-hidden">Search</label>
        <input type="text" id="ads-search-input" placeholder="Filter library entries..."
               aria-label="Filter library entries or search NASA ADS" />
        <button id="ads-search-btn" title="Search" aria-label="Execute search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 0 0 1.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 0 0-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 0 0 5.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0 .41-.41.41-1.08 0-1.49L15.5 14zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
          </svg>
        </button>
        <button id="ads-context-search-btn"
                title="Search NASA ADS using the sentence around your cursor"
                aria-label="Context-aware search from editor cursor">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M4 6h16v2H4V6zm0 5h10v2H4v-2zm0 5h16v2H4v-2zm14-5 2.5 2.5L22 12l-4 4-1.5-1.5L19 12z"/>
          </svg>
        </button>
      </div>

      <div class="ads-tabs" role="tablist" aria-label="Content tabs">
        <button class="ads-tab active" data-tab="libraries" role="tab"
                aria-selected="true" aria-controls="ads-libraries-tab" id="tab-libraries">Libraries</button>
        <button class="ads-tab" data-tab="search" role="tab"
                aria-selected="false" aria-controls="ads-search-tab" id="tab-search">Search ADS</button>
      </div>

      <div class="ads-content">
        <div id="ads-libraries-tab" class="ads-tab-content active" role="tabpanel"
             aria-labelledby="tab-libraries" tabindex="0">
          <div class="ads-library-selector">
            <label for="ads-library-select" class="visually-hidden">Select a library</label>
            <select id="ads-library-select" aria-label="Select a library">
              <option value="">Select a library...</option>
            </select>
            <button id="ads-refresh-btn" title="Refresh libraries" aria-label="Refresh library list">↻</button>
            <a id="ads-library-link" href="#" target="_blank" rel="noopener noreferrer"
               title="Open library in ADS" aria-label="Open selected library in NASA ADS">↗</a>
          </div>
          <div id="ads-documents-list" class="ads-list" role="list" aria-label="Documents in library"></div>
        </div>

        <div id="ads-search-tab" class="ads-tab-content" role="tabpanel"
             aria-labelledby="tab-search" tabindex="0" hidden>
          <div id="ads-search-results" class="ads-list" role="list" aria-label="Search results"></div>
        </div>
      </div>

      <div id="ads-status" class="ads-status" role="status" aria-live="polite"></div>
    `;

    document.body.appendChild(sidebar);

    // Event listeners
    sidebar.querySelector('.ads-close-btn').addEventListener('click', hideSidebar);
    sidebar.querySelector('#ads-search-input').addEventListener('keypress', handleSearchKeypress);
    sidebar.querySelector('#ads-search-input').addEventListener('input', handleSearchInput);
    sidebar.querySelector('#ads-search-btn').addEventListener('click', performSearch);
    sidebar.querySelector('#ads-context-search-btn').addEventListener('click', performContextSearch);
    sidebar.querySelector('#ads-library-select').addEventListener('change', handleLibraryChange);
    sidebar.querySelector('#ads-refresh-btn').addEventListener('click', async () => {
      await loadLibraries(true);
      // Also reload current library's documents to get fresh data
      if (state.currentLibrary) {
        await loadDocuments(state.currentLibrary, true);
      }
    });

    // Tab switching with keyboard support
    sidebar.querySelectorAll('.ads-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
      tab.addEventListener('keydown', handleTabKeydown);
    });

    // Import/Sync button handlers
    sidebar.querySelector('#ads-import-bib-btn').addEventListener('click', showImportModal);
    sidebar.querySelector('#ads-sync-to-bib-btn').addEventListener('click', syncLibraryToBib);

    // Global keyboard handler for the sidebar
    sidebar.addEventListener('keydown', handleSidebarKeydown);

    // Monitor for file changes to update .bib detection
    // Watch multiple areas where file changes might be reflected
    const observeTargets = [
      document.querySelector('.toolbar'),
      document.querySelector('.editor-toolbar'),
      document.querySelector('.file-tree'),
      document.querySelector('[class*="file-tree"]'),
      document.querySelector('.ide-react-panel'),
      document.body, // Fallback: watch body for major changes
    ].filter(Boolean);

    const fileObserver = new MutationObserver(() => {
      // Skip if we're in the middle of scroll collection
      if (!state.isScrollCollecting) {
        updateBibFileState();
      }
    });

    observeTargets.forEach(target => {
      try {
        fileObserver.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'aria-selected', 'data-current-file']
        });
      } catch (e) {
        console.log('ADS: Could not observe', target);
      }
    });

    // Also check on URL hash changes (Overleaf uses hash for navigation)
    window.addEventListener('hashchange', () => {
      console.log('ADS: Hash changed, checking for .bib file');
      updateBibFileState();
    });

    // Periodic check as fallback (every 2 seconds)
    setInterval(updateBibFileState, 2000);

    // Initial .bib file check (multiple times to catch late-loading UI)
    setTimeout(updateBibFileState, 500);
    setTimeout(updateBibFileState, 1500);
    setTimeout(updateBibFileState, 3000);

    console.log('ADS for Overleaf: Import/sync feature initialized');
  }

  /**
   * Handle keyboard navigation within tabs
   */
  function handleTabKeydown(event) {
    const tabs = Array.from(sidebar.querySelectorAll('.ads-tab'));
    const currentIndex = tabs.indexOf(event.target);

    let newIndex;
    switch (event.key) {
      case 'ArrowLeft':
        newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
        break;
      case 'ArrowRight':
        newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
        break;
      case 'Home':
        newIndex = 0;
        break;
      case 'End':
        newIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    tabs[newIndex].focus();
    switchTab(tabs[newIndex].dataset.tab);
  }

  /**
   * Handle global keyboard shortcuts within sidebar
   */
  function handleSidebarKeydown(event) {
    // Escape closes the sidebar
    if (event.key === 'Escape') {
      hideSidebar();
      toggleButton?.focus();
    }
  }

  /**
   * Toggle sidebar visibility
   */
  function toggleSidebar() {
    if (state.sidebarVisible) {
      hideSidebar();
    } else {
      showSidebar();
    }
  }

  /**
   * Show sidebar
   */
  function showSidebar() {
    sidebar.classList.add('visible');
    state.sidebarVisible = true;
  }

  /**
   * Hide sidebar
   */
  function hideSidebar() {
    sidebar.classList.remove('visible');
    state.sidebarVisible = false;
  }

  /**
   * Focus search input
   */
  function focusSearch() {
    const input = sidebar.querySelector('#ads-search-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  /**
   * Switch tabs
   */
  function switchTab(tabName) {
    // Update tab buttons
    sidebar.querySelectorAll('.ads-tab').forEach(t => {
      const isActive = t.dataset.tab === tabName;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive.toString());
    });

    // Update tab panels
    sidebar.querySelectorAll('.ads-tab-content').forEach(c => {
      const isActive = c.id === `ads-${tabName}-tab`;
      c.classList.toggle('active', isActive);
      if (isActive) {
        c.removeAttribute('hidden');
      } else {
        c.setAttribute('hidden', '');
      }
    });

    // Update search placeholder based on active tab
    updateSearchPlaceholder();

    // Clear search input and filter when switching tabs
    sidebar.querySelector('#ads-search-input').value = '';
    state.librarySearchQuery = '';
  }

  /**
   * Update search placeholder based on active tab
   */
  function updateSearchPlaceholder() {
    const input = sidebar.querySelector('#ads-search-input');
    const isLibrariesTab = sidebar.querySelector('#tab-libraries').classList.contains('active');
    input.placeholder = isLibrariesTab ? 'Filter library entries...' : 'Search NASA ADS...';
  }

  /**
   * Get filtered documents based on current search query
   */
  function getFilteredDocuments() {
    if (!state.librarySearchQuery) {
      return state.documents;
    }

    const query = state.librarySearchQuery;
    return state.documents.filter(doc => {
      const title = (Array.isArray(doc.title) ? doc.title[0] : doc.title || '').toLowerCase();
      const authors = (doc.author || []).join(' ').toLowerCase();
      const year = String(doc.year || '');
      const bibcode = (doc.bibcode || '').toLowerCase();
      return title.includes(query) || authors.includes(query) || year.includes(query) || bibcode.includes(query);
    });
  }

  /**
   * Load user's libraries
   */
  async function loadLibraries(forceRefresh = false) {
    setLoading(true);
    try {
      const result = await sendMessage({ 
        action: 'getLibraries', 
        payload: { forceRefresh } 
      });
      
      state.libraries = result.libraries || [];
      renderLibrarySelector();
      
      if (result.fromCache) {
        setStatus('Loaded from cache');
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Render library selector dropdown
   */
  function renderLibrarySelector() {
    const select = sidebar.querySelector('#ads-library-select');
    const currentValue = select.value; // Preserve current selection

    select.innerHTML = '<option value="">Select a library...</option>';

    state.libraries.forEach(lib => {
      const option = document.createElement('option');
      option.value = lib.id;
      option.textContent = `${lib.name} (${lib.num_documents})`;
      select.appendChild(option);
    });

    // Restore selection if library still exists
    if (currentValue && state.libraries.some(lib => lib.id === currentValue)) {
      select.value = currentValue;
    }
  }

  /**
   * Handle library selection change
   */
  async function handleLibraryChange(event) {
    const libraryId = event.target.value;
    const linkBtn = sidebar.querySelector('#ads-library-link');

    // Clear search filter when changing libraries
    state.librarySearchQuery = '';
    sidebar.querySelector('#ads-search-input').value = '';

    if (!libraryId) {
      state.currentLibrary = null;
      state.documents = [];
      linkBtn.style.display = 'none';
      renderDocuments();
      return;
    }

    state.currentLibrary = libraryId;
    linkBtn.href = `https://ui.adsabs.harvard.edu/user/libraries/${libraryId}`;
    linkBtn.style.display = 'inline-flex';
    await loadDocuments(libraryId);
  }

  /**
   * Load documents from a library
   */
  async function loadDocuments(libraryId, forceRefresh = false) {
    setLoading(true);
    try {
      const result = await sendMessage({
        action: 'getLibraryDocuments',
        payload: { libraryId, forceRefresh }
      });

      state.documents = result.documents || [];
      renderDocuments();

      // Update badge to show how many papers are missing from .bib
      updateSyncButtonBadge();
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Render documents list (filtered if search query active)
   */
  function renderDocuments() {
    const container = sidebar.querySelector('#ads-documents-list');

    if (state.documents.length === 0) {
      container.innerHTML = '<div class="ads-empty" role="status">No documents in this library</div>';
      return;
    }

    const docs = getFilteredDocuments();

    if (docs.length === 0) {
      container.innerHTML = '<div class="ads-empty" role="status">No matching entries</div>';
      return;
    }

    container.innerHTML = docs.map(doc => renderDocumentItem(doc)).join('');

    // Add click and keyboard handlers
    attachDocumentHandlers(container);
  }

  /**
   * Attach event handlers to document items
   */
  function attachDocumentHandlers(container) {
    container.querySelectorAll('.ads-doc-item').forEach(item => {
      // Click to insert
      item.addEventListener('click', (e) => {
        // Don't trigger if clicking on buttons/links
        if (e.target.closest('button, a')) return;
        insertCitation(item.dataset.bibcode);
      });

      // Keyboard: Enter to insert, arrow keys to navigate
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          insertCitation(item.dataset.bibcode);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = item.nextElementSibling;
          if (next?.classList.contains('ads-doc-item')) next.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = item.previousElementSibling;
          if (prev?.classList.contains('ads-doc-item')) prev.focus();
        }
      });
    });

    container.querySelectorAll('.ads-doc-bibtex').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyBibtex(btn.dataset.bibcode);
      });
    });
  }

  /**
   * Render a single document item
   */
  function renderDocumentItem(doc) {
    const authors = formatAuthors(doc.author);
    const year = doc.year || '';
    const title = doc.title?.[0] || 'Untitled';
    const escapedBibcode = escapeHtml(doc.bibcode);
    const matched = Array.isArray(doc.__matchedKeywords) ? doc.__matchedKeywords : [];
    const matchedHtml = matched.length
      ? `<div class="ads-doc-match">${matched.slice(0, 6).map(w =>
          `<span class="ads-match-kw">${escapeHtml(w)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="ads-doc-item" data-bibcode="${escapedBibcode}"
           role="listitem" tabindex="0"
           aria-label="${escapeHtml(authors)} ${year}: ${escapeHtml(title)}. Press Enter to insert citation.">
        <div class="ads-doc-title">${escapeHtml(title)}</div>
        <div class="ads-doc-meta">
          <span class="ads-doc-authors">${escapeHtml(authors)}</span>
          <span class="ads-doc-year">${year}</span>
        </div>
        ${matchedHtml}
        <div class="ads-doc-actions">
          <button class="ads-doc-bibtex" data-bibcode="${escapedBibcode}"
                  title="Copy BibTeX" aria-label="Copy BibTeX for ${escapeHtml(authors)} ${year}">BibTeX</button>
          <a href="https://ui.adsabs.harvard.edu/abs/${escapedBibcode}" target="_blank" rel="noopener noreferrer"
             class="ads-doc-link" title="Open in ADS" aria-label="Open ${escapeHtml(authors)} ${year} in NASA ADS">ADS</a>
        </div>
      </div>
    `;
  }

  /**
   * Handle search keypress
   */
  function handleSearchKeypress(event) {
    if (event.key === 'Enter') {
      performSearch();
    }
  }

  /**
   * Handle search input - real-time filtering for Libraries tab only
   */
  function handleSearchInput() {
    const isLibrariesTab = sidebar.querySelector('#tab-libraries').classList.contains('active');
    if (isLibrariesTab) {
      performSearch();
    }
  }

  /**
   * Perform search - context-aware based on active tab
   */
  async function performSearch() {
    const input = sidebar.querySelector('#ads-search-input');
    const query = input.value.trim();
    const isLibrariesTab = sidebar.querySelector('#tab-libraries').classList.contains('active');

    if (isLibrariesTab) {
      // Client-side filtering of library documents
      state.librarySearchQuery = query.toLowerCase();
      renderDocuments();
      if (query) {
        const filtered = getFilteredDocuments();
        setStatus(`Showing ${filtered.length} of ${state.documents.length} entries`);
      } else {
        setStatus('');
      }
      return;
    }

    // ADS API search (Search ADS tab)
    if (!query) return;

    setLoading(true);

    try {
      const result = await sendMessage({
        action: 'search',
        payload: { query, rows: 20 }
      });

      state.searchResults = result.documents || [];
      renderSearchResults();
      setStatus(`Found ${result.numFound} results`);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Context-aware search: read the active editor, extract the sentence
   * around the cursor, turn it into ADS queries, run them, rerank the
   * results by keyword overlap. Silently no-ops on non-.tex files.
   */
  async function performContextSearch() {
    if (!window.ADS4OL || typeof window.ADS4OL.extractCitationContext !== 'function') {
      setError('Context module not loaded — reload the extension.');
      return;
    }

    // Move to the Search ADS tab so results are visible.
    switchTab('search');
    setLoading(true);
    setStatus('Reading editor for context...');

    try {
      await ensurePageBridge();
      const editor = await bridgeRequest('getActiveEditor', null, 3000);
      const text = (editor && editor.text) || '';
      const cursor = (editor && editor.from) != null ? editor.from : 0;

      // Context search only makes sense in a .tex-like source. Bail cleanly
      // on a .bib or similar to avoid junk queries from BibTeX tokens.
      const activeName = (editor && editor.fileName) || readActiveFileNameFromDom();
      if (activeName && !/\.(tex|ltx|md)$/i.test(activeName)) {
        setStatus(`Context search needs a .tex file (active: ${activeName}).`);
        return;
      }

      const ctx = window.ADS4OL.extractCitationContext(text, cursor);
      if (!ctx.keywords || ctx.keywords.length < 2) {
        setStatus('Not enough context around the cursor — type a sentence or move near one.');
        return;
      }

      const queries = window.ADS4OL.buildContextQueries(ctx);
      if (queries.length === 0) {
        setStatus('Could not build an ADS query from the cursor context.');
        return;
      }

      // Run queries in order, stop once we have enough candidates.
      const TARGET_COUNT = 20;
      const merged = [];
      const seen = new Set();
      for (const q of queries) {
        if (merged.length >= TARGET_COUNT) break;
        setStatus(`Querying ADS (${merged.length}/${TARGET_COUNT})...`);
        const result = await sendMessage({
          action: 'search',
          payload: { query: q, rows: 20 }
        }).catch((e) => {
          console.log('ADS context query failed:', q, e);
          return { documents: [] };
        });
        for (const doc of (result.documents || [])) {
          if (!seen.has(doc.bibcode)) { seen.add(doc.bibcode); merged.push(doc); }
        }
      }

      if (merged.length === 0) {
        state.searchResults = [];
        renderSearchResults();
        setStatus('No matches for this context.');
        return;
      }

      const reranked = window.ADS4OL.rerankByContext(merged, ctx);
      state.searchResults = reranked;
      state.lastContextKeywords = ctx.keywords;
      renderSearchResults();

      const kw = ctx.keywords.slice(0, 5).join(', ');
      setStatus(`Found ${reranked.length} papers for: ${kw}${ctx.keywords.length > 5 ? '…' : ''}`);
    } catch (error) {
      setError(error.message || 'Context search failed');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Render search results
   */
  function renderSearchResults() {
    const container = sidebar.querySelector('#ads-search-results');

    if (state.searchResults.length === 0) {
      container.innerHTML = '<div class="ads-empty" role="status">No results found</div>';
      return;
    }

    container.innerHTML = state.searchResults.map(doc => renderDocumentItem(doc)).join('');

    // Add click and keyboard handlers (reuse same function)
    attachDocumentHandlers(container);
  }

  /**
   * Look up a document by bibcode in whichever result list is live.
   */
  function findDocByBibcode(bibcode) {
    if (!bibcode) return null;
    const all = [].concat(state.searchResults || [], state.documents || []);
    return all.find(d => d && d.bibcode === bibcode) || null;
  }

  /**
   * Insert citation at cursor.
   *
   * Fast path (addEntryToBibOnInsert = false): drop `\cite{bibcode}` at the
   * cursor, unchanged from the original behaviour.
   *
   * Smart path (addEntryToBibOnInsert = true):
   *   1. Remember the active editor + cursor (so we can write back there).
   *   2. Open the target .bib via withBibFile.
   *   3. If the paper is already in the .bib (matched by DOI / bibcode /
   *      arXiv / title), reuse the existing cite key.
   *   4. Otherwise fetch BibTeX, generate a new key per `citationKeyMode`,
   *      rewrite the entry header, append to the .bib.
   *   5. Switch back and insert `\cite{finalKey}` at the remembered cursor.
   */
  async function insertCitation(bibcode) {
    const prefs = state.preferences || {};
    const citeCmd = prefs.citeCommand || '\\cite';
    const addToBib = prefs.addEntryToBibOnInsert !== false;
    const dedupe = prefs.dedupeOnInsert !== false;
    const keyMode = prefs.citationKeyMode || 'bibcode';

    // Fast path.
    if (!addToBib) {
      const citation = `${citeCmd}{${bibcode}}`;
      setStatus('Inserting citation...');
      const ok = await insertTextAtCursor(citation);
      if (ok) setStatus(`Inserted: ${citation}`);
      else { await copyToClipboard(citation); setStatus(`Copied to clipboard: ${citation}`); }
      return;
    }

    // Smart path — requires bridge + bibtex-keys to be available.
    if (!window.ADS4OL || typeof window.ADS4OL.parseBibEntries !== 'function') {
      // Degrade to fast path silently if helpers failed to load.
      const citation = `${citeCmd}{${bibcode}}`;
      await insertTextAtCursor(citation);
      setStatus(`Inserted: ${citation}`);
      return;
    }

    const doc = findDocByBibcode(bibcode) || { bibcode };

    setStatus('Preparing citation...');
    let originalState = null;
    try {
      await ensurePageBridge();
      try { originalState = await bridgeRequest('getActiveEditor', null, 3000); }
      catch (_) { originalState = null; }

      let finalKey = null;
      let matchReason = null;
      let appended = false;

      await withBibFile(async (bibText) => {
        const entries = window.ADS4OL.parseBibEntries(bibText || '');

        if (dedupe) {
          const candidate = {
            doi: Array.isArray(doc.doi) ? doc.doi[0] : doc.doi,
            bibcode: doc.bibcode || bibcode,
            title: Array.isArray(doc.title) ? doc.title[0] : doc.title,
            eprint: doc.eprint,
            identifier: doc.identifier,
          };
          const hit = window.ADS4OL.findBibMatch(entries, candidate);
          if (hit) { finalKey = hit.key; matchReason = hit.reason; return null; }
        }

        // Fetch BibTeX for this bibcode.
        setStatus('Fetching BibTeX...');
        const exportResult = await sendMessage({
          action: 'exportBibtex',
          payload: { bibcodes: [bibcode], options: prefs }
        });
        const rawBibtex = (exportResult && exportResult.bibtex || '').trim();
        if (!rawBibtex) throw new Error('ADS returned no BibTeX for ' + bibcode);

        const existingKeys = entries.map(e => e.key);
        const keyDoc = {
          bibcode: doc.bibcode || bibcode,
          year: Array.isArray(doc.year) ? doc.year[0] : doc.year,
          author: doc.author,
          title: Array.isArray(doc.title) ? doc.title[0] : doc.title,
        };
        finalKey = window.ADS4OL.generateKey(keyDoc, existingKeys, {
          mode: keyMode,
          typed: '',
        });

        const rewritten = window.ADS4OL.rewriteBibtexKey(rawBibtex, finalKey);
        const hadText = bibText && bibText.trim();
        const head = hadText ? bibText.replace(/\s+$/, '') + '\n\n' : '';
        appended = true;
        return head + rewritten.trimEnd() + '\n';
      }, {
        pickOnAmbiguous: (candidates) => promptSidebarBibPicker(candidates),
      });

      if (!finalKey) finalKey = bibcode;

      // Insert at the remembered cursor. Prefer the bridge's replaceRange
      // (targeted, guarded) over the generic insertTextAtCursor.
      const citation = `${citeCmd}{${finalKey}}`;
      let inserted = false;
      if (originalState && originalState.fileName) {
        try {
          await bridgeRequest('replaceRange', {
            from: originalState.from,
            to: originalState.to,
            insert: citation,
            expectedFileName: originalState.fileName,
          }, 5000);
          inserted = true;
        } catch (_) { /* fall through */ }
      }
      if (!inserted) inserted = await insertTextAtCursor(citation);

      if (!inserted) {
        await copyToClipboard(citation);
        setStatus(`Copied to clipboard: ${citation}`);
        return;
      }

      if (matchReason) setStatus(`Reused ${finalKey} (${matchReason} match)`);
      else if (appended) setStatus(`Inserted ${finalKey} and added to .bib`);
      else setStatus(`Inserted ${citation}`);
    } catch (err) {
      // Last-ditch fallback to preserve the old behaviour on any failure.
      console.warn('ADS: smart insert failed, falling back:', err);
      const citation = `${citeCmd}{${bibcode}}`;
      const ok = await insertTextAtCursor(citation);
      if (ok) setStatus(`Inserted: ${citation} (fallback — ${err.message || 'error'})`);
      else { await copyToClipboard(citation); setStatus(`Copied to clipboard: ${citation}`); }
    }
  }

  /**
   * Insert text at cursor in Overleaf editor
   * Uses injected script to access CodeMirror 6 view instance
   */
  function insertTextAtCursor(text) {
    // Try CodeMirror 6 (new Overleaf editor) via injected script
    const cm6 = document.querySelector('.cm-content');
    if (cm6) {
      return insertViaCM6(text);
    }

    // Try Ace editor (legacy) via injected script
    const aceEditor = document.querySelector('.ace_editor');
    if (aceEditor) {
      return insertViaAce(text, aceEditor);
    }

    return false;
  }

  /**
   * Insert text using CodeMirror 6 by injecting a script into the page context
   */
  function insertViaCM6(text) {
    // Create a unique callback ID for this insertion
    const callbackId = `ads_cm6_insert_${Date.now()}`;

    // Create a promise to wait for the result
    return new Promise((resolve) => {
      // Listen for the result
      const handler = (event) => {
        if (event.data && event.data.type === callbackId) {
          window.removeEventListener('message', handler);
          resolve(event.data.success);
        }
      };
      window.addEventListener('message', handler);

      // Inject script to access CodeMirror 6 view
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          const text = ${JSON.stringify(text)};
          const callbackId = ${JSON.stringify(callbackId)};

          // Find the CodeMirror 6 view instance
          // Overleaf stores it on the DOM element
          const cmContent = document.querySelector('.cm-content');
          if (!cmContent) {
            window.postMessage({ type: callbackId, success: false }, '*');
            return;
          }

          // Walk up to find the element with the view
          let element = cmContent;
          let view = null;

          while (element && !view) {
            // CodeMirror 6 stores view reference in various ways
            if (element.cmView) {
              view = element.cmView.view || element.cmView;
            }
            // Try the EditorView approach
            const cmElement = element.closest('.cm-editor');
            if (cmElement && cmElement.cmView) {
              view = cmElement.cmView.view || cmElement.cmView;
            }
            element = element.parentElement;
          }

          // Alternative: look for Overleaf's editor instance
          if (!view && window._ide && window._ide.editorManager) {
            const editor = window._ide.editorManager.getCurrentDocumentEditor();
            if (editor && editor.view) {
              view = editor.view;
            }
          }

          // Another alternative: query the editor-container
          if (!view) {
            const editorContainer = document.querySelector('.editor-container');
            if (editorContainer) {
              // Search for view in the scope chain
              const cmEditor = editorContainer.querySelector('.cm-editor');
              if (cmEditor) {
                // Access via closure if available
                const viewKey = Object.keys(cmEditor).find(k => k.startsWith('__'));
                if (viewKey && cmEditor[viewKey] && cmEditor[viewKey].view) {
                  view = cmEditor[viewKey].view;
                }
              }
            }
          }

          if (view && view.dispatch && view.state) {
            // Insert at current selection
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length }
            });
            view.focus();
            window.postMessage({ type: callbackId, success: true }, '*');
          } else {
            // Fallback: try using keyboard simulation
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.classList.contains('cm-content') ||
                activeElement.closest('.cm-content'))) {
              // Try execCommand as last resort
              document.execCommand('insertText', false, text);
              window.postMessage({ type: callbackId, success: true }, '*');
            } else {
              window.postMessage({ type: callbackId, success: false }, '*');
            }
          }
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();

      // Timeout fallback
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(false);
      }, 1000);
    });
  }

  /**
   * Insert text using Ace editor by injecting a script into the page context
   */
  function insertViaAce(text, aceElement) {
    const callbackId = `ads_ace_insert_${Date.now()}`;

    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.data && event.data.type === callbackId) {
          window.removeEventListener('message', handler);
          resolve(event.data.success);
        }
      };
      window.addEventListener('message', handler);

      const script = document.createElement('script');
      script.textContent = `
        (function() {
          const text = ${JSON.stringify(text)};
          const callbackId = ${JSON.stringify(callbackId)};

          // Find ace editor
          const aceElement = document.querySelector('.ace_editor');
          if (aceElement && window.ace) {
            try {
              const editor = ace.edit(aceElement);
              editor.insert(text);
              editor.focus();
              window.postMessage({ type: callbackId, success: true }, '*');
            } catch (e) {
              window.postMessage({ type: callbackId, success: false }, '*');
            }
          } else {
            window.postMessage({ type: callbackId, success: false }, '*');
          }
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();

      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(false);
      }, 1000);
    });
  }

  /**
   * Copy BibTeX to clipboard
   */
  async function copyBibtex(bibcode) {
    try {
      const result = await sendMessage({
        action: 'exportBibtex',
        payload: { 
          bibcodes: [bibcode],
          options: state.preferences || {}
        }
      });
      
      await copyToClipboard(result.bibtex);
      setStatus('BibTeX copied to clipboard');
    } catch (error) {
      setError(error.message);
    }
  }

  /**
   * Copy text to clipboard
   */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    }
  }

  /**
   * Format authors for display
   */
  function formatAuthors(authors, max = 2) {
    if (!authors || authors.length === 0) return 'Unknown';
    
    const formatted = authors.slice(0, max).map(a => {
      const parts = a.split(',');
      return parts[0].trim();
    });
    
    if (authors.length > max) {
      formatted.push('et al.');
    }
    
    return formatted.join(', ');
  }

  /**
   * Set loading state
   */
  function setLoading(loading) {
    state.isLoading = loading;
    sidebar.classList.toggle('loading', loading);
  }

  /**
   * Set status message
   */
  function setStatus(message) {
    const status = sidebar.querySelector('#ads-status');
    status.textContent = message;
    status.className = 'ads-status';
    
    setTimeout(() => {
      status.textContent = '';
    }, 3000);
  }

  /**
   * Set error message
   */
  function setError(message) {
    const status = sidebar.querySelector('#ads-status');
    status.textContent = message;
    status.className = 'ads-status error';
  }

  /**
   * Escape HTML
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================================
  // BibTeX File Detection and Editing
  // ============================================================================

  /**
   * Detect if a .bib file is currently open in the editor
   * Returns the filename if a .bib file is open, null otherwise
   */
  function detectBibFile() {
    // Strategy 1: Check the URL hash (Overleaf uses hash for file navigation)
    const hash = window.location.hash;
    if (hash && hash.includes('.bib')) {
      const match = hash.match(/([^/]+\.bib)/i);
      if (match) {
        console.log('ADS: Detected .bib from URL hash:', match[1]);
        return match[1];
      }
    }

    // Strategy 2: Look for the current file name in Overleaf's toolbar/header area
    // Overleaf shows filename in various places depending on version
    const selectors = [
      // New Overleaf (React-based)
      '.toolbar-left .name',
      '.file-tree-item.selected .name',
      '.entity.selected .name',
      '[class*="file-tree"] [class*="selected"] [class*="name"]',
      // Breadcrumb/path display
      '.toolbar-filename',
      '.editor-toolbar .filename',
      // Tab-based display
      '.nav-tabs .active',
      '.tab.active .name',
      // Generic patterns
      '[data-current-file]',
      '[aria-current="page"]',
    ];

    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim() || el.getAttribute('data-current-file') || '';
          if (text.endsWith('.bib')) {
            // Only log if this is a new detection (different from current)
            if (state.currentBibFile !== text) {
              console.log('ADS: Detected .bib file:', text);
            }
            return text;
          }
        }
      } catch (e) {
        // Ignore invalid selectors
      }
    }

    // Strategy 3: Search more broadly in the toolbar area
    const toolbar = document.querySelector('.toolbar, .editor-toolbar, [class*="toolbar"]');
    if (toolbar) {
      const allText = toolbar.textContent || '';
      const bibMatch = allText.match(/(\S+\.bib)/i);
      if (bibMatch) {
        if (state.currentBibFile !== bibMatch[1]) {
          console.log('ADS: Detected .bib file:', bibMatch[1]);
        }
        return bibMatch[1];
      }
    }

    // Strategy 4: Check if any .bib-related classes exist
    const bibIndicators = document.querySelectorAll('[class*="bib"], [data-file-type="bib"]');
    for (const el of bibIndicators) {
      if (el.closest('.selected, .active, [aria-selected="true"]')) {
        const name = el.textContent?.trim() || 'references.bib';
        if (name.endsWith('.bib')) {
          if (state.currentBibFile !== name) {
            console.log('ADS: Detected .bib file:', name);
          }
          return name;
        }
      }
    }

    return null;
  }

  /**
   * Read the content of the currently open editor
   * Returns a Promise that resolves to the editor content string
   *
   * Note: Uses DOM-based approach to avoid CSP issues with inline scripts.
   * CodeMirror 6 virtualizes content, so we scroll through the document
   * to force all content to render, then collect it.
   */
  function readEditorContent() {
    return new Promise(async (resolve) => {
      // Method 1: Try to get content from CodeMirror's internal state
      // Look for the editor view stored on DOM elements
      const cmEditor = document.querySelector('.cm-editor');
      if (cmEditor) {
        // Try to find the view through various properties CM6 might use
        const possibleViewKeys = Object.keys(cmEditor).filter(k =>
          k.startsWith('__') || k === 'cmView' || k === 'view'
        );

        for (const key of possibleViewKeys) {
          try {
            const obj = cmEditor[key];
            if (obj && obj.view && obj.view.state && obj.view.state.doc) {
              resolve(obj.view.state.doc.toString());
              return;
            }
            if (obj && obj.state && obj.state.doc) {
              resolve(obj.state.doc.toString());
              return;
            }
          } catch (e) {
            // Continue trying other keys
          }
        }
      }

      // Method 2: For CodeMirror 6, scroll through document to collect all content
      // CM6 virtualizes rendering, so we need to scroll to force-render all lines
      const cmScroller = document.querySelector('.cm-scroller');
      const cmContent = document.querySelector('.cm-content');
      if (cmScroller && cmContent) {
        const content = await scrollAndCollectCM6Content(cmScroller, cmContent);
        if (content) {
          resolve(content);
          return;
        }
      }

      // Method 3: Read from CodeMirror 6 visible content (fallback)
      if (cmContent) {
        const lines = cmContent.querySelectorAll('.cm-line');
        if (lines.length > 0) {
          resolve(Array.from(lines).map(line => line.textContent).join('\n'));
          return;
        }

        const content = cmContent.textContent;
        if (content) {
          resolve(content);
          return;
        }
      }

      // Method 4: Try Ace editor
      const aceContent = document.querySelector('.ace_text-layer');
      if (aceContent) {
        const lines = aceContent.querySelectorAll('.ace_line');
        if (lines.length > 0) {
          resolve(Array.from(lines).map(line => line.textContent).join('\n'));
          return;
        }
      }

      // Method 5: Try any visible editor content
      const editorContainer = document.querySelector('.editor-container, .cm-editor, .ace_editor');
      if (editorContainer) {
        const content = editorContainer.textContent;
        if (content && content.trim().length > 0) {
          resolve(content);
          return;
        }
      }

      resolve(null);
    });
  }

  /**
   * Scroll through CM6 editor to collect all content
   * CM6 virtualizes content, only rendering visible lines.
   * We scroll through the document, collecting line data as we go.
   * Uses line numbers from the gutter to accurately track lines.
   */
  async function scrollAndCollectCM6Content(scroller, content) {
    const originalScroll = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;

    // If document fits in view, just read what's visible
    if (scrollHeight <= clientHeight + 50) {
      const lines = content.querySelectorAll('.cm-line');
      return Array.from(lines).map(line => line.textContent).join('\n');
    }

    // Map to collect unique lines by line number
    const lineMap = new Map(); // lineNumber -> content

    // Function to collect currently visible lines using gutter line numbers
    function collectVisibleLines() {
      // Get line numbers from gutter
      const gutterLines = document.querySelectorAll('.cm-lineNumbers .cm-gutterElement');
      const contentLines = content.querySelectorAll('.cm-line');

      // Match gutter line numbers with content lines by position
      gutterLines.forEach(gutterEl => {
        const lineNum = parseInt(gutterEl.textContent, 10);
        if (isNaN(lineNum)) return;

        // Find the content line at the same vertical position
        const gutterRect = gutterEl.getBoundingClientRect();

        for (const line of contentLines) {
          const lineRect = line.getBoundingClientRect();
          // Lines are aligned if their tops are within a few pixels
          if (Math.abs(lineRect.top - gutterRect.top) < 5) {
            if (!lineMap.has(lineNum)) {
              lineMap.set(lineNum, line.textContent);
            }
            break;
          }
        }
      });

      // Fallback: if no gutter, use order-based approach
      if (gutterLines.length === 0) {
        // Estimate line number from scroll position and line height
        const firstLine = contentLines[0];
        if (firstLine) {
          const lineHeight = firstLine.getBoundingClientRect().height || 20;
          const estimatedFirstLine = Math.floor(scroller.scrollTop / lineHeight) + 1;
          contentLines.forEach((line, idx) => {
            const lineNum = estimatedFirstLine + idx;
            if (!lineMap.has(lineNum)) {
              lineMap.set(lineNum, line.textContent);
            }
          });
        }
      }
    }

    // Scroll through document in chunks
    const scrollStep = clientHeight - 50; // Small overlap to not miss lines
    let currentScroll = 0;

    state.isScrollCollecting = true;

    try {
      while (currentScroll < scrollHeight) {
        scroller.scrollTop = currentScroll;
        await sleep(30); // Brief delay for rendering
        collectVisibleLines();
        currentScroll += scrollStep;
      }

      // Scroll to end to get last lines
      scroller.scrollTop = scrollHeight;
      await sleep(30);
      collectVisibleLines();
    } finally {
      // Restore original scroll position and clear flag
      scroller.scrollTop = originalScroll;
      state.isScrollCollecting = false;
    }

    // Sort lines by line number and join
    const sortedLines = Array.from(lineMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(entry => entry[1]);

    return sortedLines.join('\n');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Append text to the end of the editor content
   * Returns a Promise that resolves to true if successful
   *
   * Note: Due to CSP restrictions, we can't directly modify the editor.
   * Instead, we copy the text to clipboard and notify the user.
   */
  async function appendToEditor(text) {
    // Due to CSP restrictions, we cannot inject scripts to modify the editor directly.
    // The best we can do is copy to clipboard and let the user paste.
    try {
      await navigator.clipboard.writeText(text);
      console.log('ADS: Copied text to clipboard for manual pasting');
      return false; // Return false to indicate manual paste is needed
    } catch (e) {
      console.error('ADS: Failed to copy to clipboard:', e);
      return false;
    }
  }

  /**
   * Update the UI based on whether a .bib file is currently open
   */
  function updateBibFileState() {
    const bibFile = detectBibFile();
    const changed = state.currentBibFile !== bibFile;
    state.currentBibFile = bibFile;

    if (changed) {
      console.log('ADS: .bib file state changed:', bibFile || '(none)');
      // Update the sync button badge when .bib file changes
      updateSyncButtonBadge();
    }

    // Buttons are now always visible - users can click them even without detection
    // The import will read whatever is in the editor

    return bibFile;
  }

  // ============================================================================
  // Import Modal and Logic
  // ============================================================================

  let importModal = null;

  /**
   * Show the import modal
   */
  async function showImportModal() {
    // Try to detect .bib file, but don't require it
    const bibFile = updateBibFileState() || 'current file';

    // Create modal if it doesn't exist
    if (!importModal) {
      createImportModal();
    }

    // Reset modal state
    const modalContent = importModal.querySelector('.ads-modal-body');
    modalContent.innerHTML = `
      <div class="ads-import-step" id="ads-import-step-config">
        <p>Import entries from <strong>${escapeHtml(bibFile)}</strong> to an ADS library.</p>

        <div class="ads-form-group">
          <label>
            <input type="radio" name="ads-import-target" value="new" checked>
            Create new library
          </label>
          <div class="ads-indent" id="ads-new-lib-fields">
            <input type="text" id="ads-new-lib-name" placeholder="Library name" />
            <input type="text" id="ads-new-lib-desc" placeholder="Description (optional)" />
          </div>
        </div>

        <div class="ads-form-group">
          <label>
            <input type="radio" name="ads-import-target" value="existing">
            Add to existing library
          </label>
          <div class="ads-indent" id="ads-existing-lib-fields" style="display:none">
            <select id="ads-import-lib-select">
              <option value="">Select a library...</option>
              ${state.libraries.map(lib => `<option value="${lib.id}">${escapeHtml(lib.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="ads-modal-actions">
          <button id="ads-import-scan-btn" class="ads-btn primary">Scan & Import</button>
          <button id="ads-import-cancel-btn" class="ads-btn secondary">Cancel</button>
        </div>
      </div>

      <div class="ads-import-step" id="ads-import-step-progress" style="display:none">
        <div class="ads-progress">
          <div class="ads-progress-bar indeterminate" id="ads-import-progress-bar"></div>
        </div>
        <p id="ads-import-progress-text" class="ads-progress-status">
          <span class="ads-spinner"></span>Processing...
        </p>
        <p id="ads-import-progress-counts" class="ads-progress-counts" style="display:none"></p>
        <div class="ads-modal-actions" id="ads-import-progress-actions" style="display:none">
          <button id="ads-import-cancel-scan-btn" class="ads-btn secondary">Cancel</button>
        </div>
      </div>

      <div class="ads-import-step" id="ads-import-step-results" style="display:none">
        <div id="ads-import-results"></div>
        <div class="ads-modal-actions">
          <button id="ads-import-confirm-btn" class="ads-btn primary">Create Library</button>
          <button id="ads-import-back-btn" class="ads-btn secondary">Back</button>
        </div>
      </div>
    `;

    // Add event listeners
    modalContent.querySelectorAll('input[name="ads-import-target"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const newFields = modalContent.querySelector('#ads-new-lib-fields');
        const existingFields = modalContent.querySelector('#ads-existing-lib-fields');
        if (e.target.value === 'new') {
          newFields.style.display = 'block';
          existingFields.style.display = 'none';
        } else {
          newFields.style.display = 'none';
          existingFields.style.display = 'block';
        }
      });
    });

    modalContent.querySelector('#ads-import-scan-btn').addEventListener('click', startImportScan);
    modalContent.querySelector('#ads-import-cancel-btn').addEventListener('click', hideImportModal);

    // Show modal
    importModal.classList.add('visible');
  }

  /**
   * Create the import modal element
   */
  function createImportModal() {
    importModal = document.createElement('div');
    importModal.id = 'ads-import-modal';
    importModal.className = 'ads-modal';
    importModal.innerHTML = `
      <div class="ads-modal-content">
        <div class="ads-modal-header">
          <h3>Import to ADS Library</h3>
          <button class="ads-modal-close">&times;</button>
        </div>
        <div class="ads-modal-body"></div>
      </div>
    `;

    document.body.appendChild(importModal);

    // Close button
    importModal.querySelector('.ads-modal-close').addEventListener('click', hideImportModal);

    // Click outside to close
    importModal.addEventListener('click', (e) => {
      if (e.target === importModal) {
        hideImportModal();
      }
    });
  }

  /**
   * Hide the import modal
   */
  function hideImportModal() {
    if (importModal) {
      importModal.classList.remove('visible');
    }
  }

  // Chunk size keeps each resolveBibtexChunk round-trip well under the
  // MV3 30s service-worker idle window even for slow connections.
  //
  // Each chunk is now batch-resolved on the SW side — a single ADS call
  // handles up to 100 identifier-bearing entries — so we can afford to send
  // larger chunks without increasing query count. The practical cap is
  // title-only entries within the chunk (still one query apiece): with ~30%
  // title-only entries, a 200-item chunk is ~60 serial-ish queries, well
  // under 30s at 10 req/s.
  const IMPORT_CHUNK_SIZE = 200;

  /**
   * Render an inline .bib picker by hiding the progress step's children and
   * appending the picker. Resolves to the chosen filename, or null on
   * cancel. Leaves the progress step's original children intact so DOM
   * references captured by the caller remain valid.
   */
  function promptBibFilePicker(candidates, progressStep) {
    const hidden = [];
    for (const child of Array.from(progressStep.children)) {
      hidden.push([child, child.style.display]);
      child.style.display = 'none';
    }
    const picker = document.createElement('div');
    picker.className = 'ads-bib-picker';
    picker.innerHTML = `
      <p>This project has several <code>.bib</code> files. Which one should receive the import?</p>
      <div class="ads-bib-picker-list">
        ${candidates.map(f => `<button type="button" class="ads-btn secondary ads-bib-picker-item" data-bib="${escapeHtml(f)}">${escapeHtml(f)}</button>`).join('')}
      </div>
      <div class="ads-modal-actions">
        <button type="button" class="ads-btn secondary" data-bib-cancel="1">Cancel</button>
      </div>
    `;
    progressStep.appendChild(picker);

    return new Promise((resolve) => {
      const finish = (value) => {
        picker.remove();
        for (const [child, prev] of hidden) child.style.display = prev || '';
        resolve(value);
      };
      picker.querySelectorAll('[data-bib]').forEach((btn) => {
        btn.addEventListener('click', () => finish(btn.dataset.bib), { once: true });
      });
      picker.querySelector('[data-bib-cancel]')
        .addEventListener('click', () => finish(null), { once: true });
    });
  }

  // Flipped by the Cancel button during an in-progress scan.
  let importScanCancelled = false;

  /**
   * Start the import scan process
   */
  async function startImportScan() {

    const modalContent = importModal.querySelector('.ads-modal-body');
    const configStep = modalContent.querySelector('#ads-import-step-config');
    const progressStep = modalContent.querySelector('#ads-import-step-progress');
    const resultsStep = modalContent.querySelector('#ads-import-step-results');

    // Get configuration
    const isNewLibrary = modalContent.querySelector('input[name="ads-import-target"]:checked').value === 'new';
    const newLibName = modalContent.querySelector('#ads-new-lib-name').value.trim();
    const newLibDesc = modalContent.querySelector('#ads-new-lib-desc').value.trim();
    const existingLibId = modalContent.querySelector('#ads-import-lib-select').value;


    if (isNewLibrary && !newLibName) {
      setError('Please enter a library name');
      return;
    }
    if (!isNewLibrary && !existingLibId) {
      setError('Please select a library');
      return;
    }

    // Switch to progress view immediately
    configStep.style.display = 'none';
    progressStep.style.display = 'block';

    const progressBar = modalContent.querySelector('#ads-import-progress-bar');
    const progressText = modalContent.querySelector('#ads-import-progress-text');
    const progressCounts = modalContent.querySelector('#ads-import-progress-counts');
    const progressActions = modalContent.querySelector('#ads-import-progress-actions');
    const cancelScanBtn = modalContent.querySelector('#ads-import-cancel-scan-btn');

    // Reset progress UI
    progressBar.classList.add('indeterminate');
    progressBar.style.width = '';
    progressCounts.style.display = 'none';
    progressCounts.textContent = '';
    progressActions.style.display = 'none';
    importScanCancelled = false;
    cancelScanBtn.disabled = false;
    cancelScanBtn.textContent = 'Cancel';
    cancelScanBtn.onclick = () => {
      importScanCancelled = true;
      cancelScanBtn.disabled = true;
      cancelScanBtn.textContent = 'Cancelling...';
    };

    // Phase 1: Locate and read the target .bib file — anywhere in the project.
    progressText.innerHTML = '<span class="ads-spinner"></span>Locating .bib file...';

    let bibtexContent = '';
    let resolvedTarget = '';
    try {
      const pickedWrap = await withBibFile(async (bibText, ctx) => {
        bibtexContent = bibText || '';
        resolvedTarget = ctx.target;
        return null; // read-only
      }, {
        pickOnAmbiguous: (candidates) => promptBibFilePicker(candidates, progressStep),
      });
      if (resolvedTarget && pickedWrap?.target) {
        progressText.innerHTML = `<span class="ads-spinner"></span>Using <strong>${escapeHtml(pickedWrap.target)}</strong>...`;
      }
    } catch (err) {
      progressStep.style.display = 'none';
      configStep.style.display = 'block';
      setError(err.message || 'Could not read a .bib file from this project.');
      return;
    }

    if (!bibtexContent || !bibtexContent.trim()) {
      progressStep.style.display = 'none';
      configStep.style.display = 'block';
      setError(`The .bib file${resolvedTarget ? ' (' + resolvedTarget + ')' : ''} appears to be empty.`);
      return;
    }

    try {
      // Phase 2: Parse locally in the SW (fast, no network)
      progressText.innerHTML = '<span class="ads-spinner"></span>Parsing BibTeX...';

      const parsed = await sendMessage({
        action: 'parseBibtex',
        payload: { bibtexContent }
      });
      const entries = parsed?.entries || [];

      if (entries.length === 0) {
        progressStep.style.display = 'none';
        configStep.style.display = 'block';
        setError('No BibTeX entries found in the file.');
        return;
      }

      // Phase 3: Resolve in chunks, streaming progress
      const total = entries.length;
      const allResults = [];
      let foundCount = 0;
      let notFoundCount = 0;

      progressBar.classList.remove('indeterminate');
      progressBar.style.width = '0%';
      progressCounts.style.display = 'block';
      progressActions.style.display = 'block';

      const updateProgress = () => {
        const done = allResults.length;
        const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
        progressBar.style.width = `${pct}%`;
        progressText.innerHTML = `<span class="ads-spinner"></span>Resolving entries... ${done} / ${total}`;
        progressCounts.textContent = `Found: ${foundCount} · Not found: ${notFoundCount}`;
      };
      updateProgress();

      let chunkErrorCount = 0;
      let lastChunkError = null;
      for (let i = 0; i < entries.length; i += IMPORT_CHUNK_SIZE) {
        if (importScanCancelled) break;

        const chunk = entries.slice(i, i + IMPORT_CHUNK_SIZE);
        let chunkResults = [];
        try {
          const chunkResult = await sendMessage({
            action: 'resolveBibtexChunk',
            payload: { entries: chunk }
          });
          chunkResults = chunkResult?.results || [];
        } catch (err) {
          // One bad chunk shouldn't abort the whole import. Record the
          // entries as unresolved-with-error and continue.
          chunkErrorCount++;
          lastChunkError = err;
          chunkResults = chunk.map(e => ({
            citeKey: e.citeKey,
            entryType: e.entryType,
            bibcode: null,
            method: 'not_found',
            confidence: 0,
            fields: e.fields,
            error: err.message || String(err),
          }));
        }

        for (const r of chunkResults) {
          allResults.push(r);
          if (r.bibcode) foundCount++;
          else notFoundCount++;
        }
        updateProgress();
      }

      if (chunkErrorCount > 0) {
        console.warn(
          `ADS import: ${chunkErrorCount} chunk(s) failed. Last error:`,
          lastChunkError
        );
      }

      // Phase 4: Show results (full or partial if cancelled)
      const categorized = categorizeResultsLocal(allResults);

      progressStep.style.display = 'none';
      resultsStep.style.display = 'block';

      const resultsDiv = modalContent.querySelector('#ads-import-results');
      const cancelledNote = importScanCancelled
        ? `<p class="ads-import-cancelled-note"><em>Scan cancelled — showing ${allResults.length} of ${total} entries.</em></p>`
        : '';

      resultsDiv.innerHTML = `
        ${cancelledNote}
        <div class="ads-import-summary">
          <p><strong>Found:</strong> ${categorized.stats.foundCount} papers</p>
          <p><strong>Not found:</strong> ${categorized.stats.notFoundCount} entries</p>
          ${categorized.stats.errorCount > 0 ? `<p><strong>Errors:</strong> ${categorized.stats.errorCount}</p>` : ''}
        </div>

        ${categorized.found.length > 0 ? `
          <details class="ads-import-details" open>
            <summary>Papers to add (${categorized.found.length})</summary>
            <ul class="ads-import-list">
              ${categorized.found.map(r => `
                <li class="ads-import-item found">
                  <span class="ads-import-key">${escapeHtml(r.citeKey)}</span>
                  <span class="ads-import-method">(${r.method})</span>
                </li>
              `).join('')}
            </ul>
          </details>
        ` : ''}

        ${categorized.notFound.length > 0 ? `
          <details class="ads-import-details">
            <summary>Not found (${categorized.notFound.length})</summary>
            <ul class="ads-import-list">
              ${categorized.notFound.map(r => `
                <li class="ads-import-item not-found">
                  <span class="ads-import-key">${escapeHtml(r.citeKey)}</span>
                  ${r.fields?.title ? `<span class="ads-import-title">${escapeHtml(r.fields.title.substring(0, 50))}...</span>` : ''}
                </li>
              `).join('')}
            </ul>
          </details>
        ` : ''}
      `;

      // Store results for confirmation
      importModal.dataset.resolvedBibcodes = JSON.stringify(categorized.found.map(r => r.bibcode));
      importModal.dataset.isNewLibrary = isNewLibrary;
      importModal.dataset.newLibName = newLibName;
      importModal.dataset.newLibDesc = newLibDesc;
      importModal.dataset.existingLibId = existingLibId;

      // Add confirm button handler
      const confirmBtn = modalContent.querySelector('#ads-import-confirm-btn');
      confirmBtn.textContent = isNewLibrary ? 'Create Library' : 'Add to Library';
      confirmBtn.onclick = confirmImport;

      const backBtn = modalContent.querySelector('#ads-import-back-btn');
      backBtn.onclick = () => {
        resultsStep.style.display = 'none';
        configStep.style.display = 'block';
      };

    } catch (error) {
      progressStep.style.display = 'none';
      configStep.style.display = 'block';
      setError(`Import failed: ${error.message}`);
    }
  }

  /**
   * Categorize resolution results locally (matches categorizeResults in bibtex-resolver.js).
   * Kept client-side to avoid a pointless round-trip after all chunks have returned.
   */
  function categorizeResultsLocal(results) {
    const found = results.filter(r => r.bibcode !== null && r.bibcode !== undefined);
    const notFound = results.filter(r => !r.bibcode);
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

  /**
   * Confirm and execute the import
   */
  async function confirmImport() {
    const bibcodes = JSON.parse(importModal.dataset.resolvedBibcodes || '[]');
    const isNewLibrary = importModal.dataset.isNewLibrary === 'true';
    const newLibName = importModal.dataset.newLibName;
    const newLibDesc = importModal.dataset.newLibDesc;
    const existingLibId = importModal.dataset.existingLibId;

    if (bibcodes.length === 0) {
      setError('No papers to import');
      return;
    }

    try {
      // Each sendMessage round-trip must finish well under the MV3 ~30s
      // service-worker idle window; otherwise the message port closes and
      // the caller sees "asynchronous response ... message channel closed".
      // We therefore drive the ADS writes from here in batches of
      // ADD_LIB_CHUNK bibcodes per message.
      const ADD_LIB_CHUNK = 400;

      const firstChunk = bibcodes.slice(0, ADD_LIB_CHUNK);
      const restChunks = [];
      for (let i = ADD_LIB_CHUNK; i < bibcodes.length; i += ADD_LIB_CHUNK) {
        restChunks.push(bibcodes.slice(i, i + ADD_LIB_CHUNK));
      }

      let newLibraryId = null;
      let totalAdded = 0;
      const totalToAdd = bibcodes.length;
      const extractAdded = (r, fallback) => {
        if (!r) return fallback;
        if (typeof r.number_added === 'number') return r.number_added;
        if (typeof r.added === 'number') return r.added;
        return fallback;
      };

      if (isNewLibrary) {
        setStatus(`Creating library (${Math.min(firstChunk.length, totalToAdd)} / ${totalToAdd})...`);
        const result = await sendMessage({
          action: 'createLibrary',
          payload: {
            name: newLibName,
            options: {
              description: newLibDesc || `Imported from Overleaf on ${new Date().toLocaleDateString()}`,
              bibcodes: firstChunk,
              isPublic: false
            }
          }
        });
        newLibraryId = result && result.id;
        totalAdded += extractAdded(result, firstChunk.length);
        if (!newLibraryId) throw new Error('ADS did not return a library id.');
      } else {
        newLibraryId = existingLibId;
        if (firstChunk.length) {
          setStatus(`Adding ${Math.min(firstChunk.length, totalToAdd)} / ${totalToAdd}...`);
          const result = await sendMessage({
            action: 'addToLibrary',
            payload: { libraryId: existingLibId, bibcodes: firstChunk }
          });
          totalAdded += extractAdded(result, firstChunk.length);
        }
      }

      for (const chunk of restChunks) {
        setStatus(`Adding ${Math.min(totalAdded + chunk.length, totalToAdd)} / ${totalToAdd}...`);
        const result = await sendMessage({
          action: 'addToLibrary',
          payload: { libraryId: newLibraryId, bibcodes: chunk }
        });
        totalAdded += extractAdded(result, chunk.length);
      }

      if (isNewLibrary) {
        setStatus(`Created library "${newLibName}" with ${totalAdded} papers`);
      } else {
        setStatus(`Added ${totalAdded} papers to library`);
      }

      // Refresh libraries list
      await loadLibraries(true);

      // Auto-select the new/updated library
      if (newLibraryId) {
        const select = sidebar.querySelector('#ads-library-select');
        if (select) {
          select.value = newLibraryId;
          // Trigger the change handler to load documents
          await handleLibraryChange({ target: select });
        }
      }

      hideImportModal();

    } catch (error) {
      setError(`Import failed: ${error.message}`);
    }
  }

  /**
   * Count how many library papers are NOT in the current .bib file
   * Used to show notification badge on "Add to .bib" button
   */
  async function countMissingInBib() {
    if (!state.documents || state.documents.length === 0) {
      return 0;
    }

    try {
      // Only read when a .bib file is already the active editor — we do not
      // switch files just to compute the badge.
      const active = readActiveFileNameFromDom();
      if (!active || !/\.bib$/i.test(active)) {
        return 0;
      }
      await ensurePageBridge();
      const editor = await bridgeRequest('getActiveEditor', null, 2000);
      const bibtexContent = editor?.text || '';
      if (!bibtexContent) return 0;

      const { bibcodes, dois, arxivIds } = extractExistingBibIdentifiers(bibtexContent);
      const normalizeBibcode = (bc) => bc.replace(/\./g, '').toLowerCase();
      const getDocArxivId = (doc) => {
        if (!doc.identifier) return null;
        for (const id of doc.identifier) {
          const m = id.match(/(?:arXiv:)?(\d{4}\.\d{4,5})/i);
          if (m) return m[1].toLowerCase();
        }
        return null;
      };
      let missingCount = 0;
      for (const doc of state.documents) {
        if (bibcodes.has(normalizeBibcode(doc.bibcode))) continue;
        if (doc.doi && dois.has(String(doc.doi[0] || '').toLowerCase())) continue;
        const a = getDocArxivId(doc);
        if (a && arxivIds.has(a)) continue;
        missingCount++;
      }
      return missingCount;
    } catch (e) {
      console.log('ADS: Error counting missing papers:', e);
      return 0;
    }
  }

  /**
   * Update the "Add to .bib" button with a badge showing missing paper count
   */
  async function updateSyncButtonBadge() {
    const btn = sidebar?.querySelector('#ads-sync-to-bib-btn');
    if (!btn) return;

    const count = await countMissingInBib();

    if (count > 0) {
      btn.innerHTML = `<span class="ads-btn-icon">↓</span> Add to .bib <span class="ads-badge">${count}</span>`;
      btn.title = `${count} paper${count === 1 ? '' : 's'} in library not in your .bib file`;
    } else {
      btn.innerHTML = '<span class="ads-btn-icon">↓</span> Add to .bib';
      btn.title = 'Add missing papers from selected library to .bib file';
    }
  }

  /**
   * Sync papers from selected library to the .bib file (add-only).
   * Works regardless of which project file is currently active — the helper
   * resolves the target .bib, switches to it, writes via the page bridge,
   * and switches back.
   */
  async function syncLibraryToBib() {
    if (!state.currentLibrary) {
      setError('Please select a library first');
      return;
    }

    setStatus('Fetching library...');
    try {
      const libraryResult = await sendMessage({
        action: 'getLibraryDocuments',
        payload: { libraryId: state.currentLibrary, forceRefresh: true }
      });
      const libraryDocs = libraryResult.documents || [];
      if (libraryDocs.length === 0) {
        setStatus('Library is empty');
        return;
      }

      setStatus('Locating .bib file...');
      let missingCount = 0;
      let fallbackBibtex = null;

      const result = await withBibFile(async (bibtexContent) => {
        const { bibcodes, dois, arxivIds } = extractExistingBibIdentifiers(bibtexContent || '');

        const getDocArxivId = (doc) => {
          if (!doc.identifier) return null;
          for (const id of doc.identifier) {
            const m = id.match(/(?:arXiv:)?(\d{4}\.\d{4,5})/i);
            if (m) return m[1].toLowerCase();
          }
          return null;
        };
        const normalizeBibcode = (bc) => bc.replace(/\./g, '').toLowerCase();

        const missingPapers = libraryDocs.filter(doc => {
          if (bibcodes.has(normalizeBibcode(doc.bibcode))) return false;
          if (doc.doi && dois.has(String(doc.doi[0] || '').toLowerCase())) return false;
          const a = getDocArxivId(doc);
          if (a && arxivIds.has(a)) return false;
          return true;
        });
        missingCount = missingPapers.length;
        if (missingCount === 0) return null;

        setStatus(`Exporting ${missingCount} papers...`);
        const exportResult = await sendMessage({
          action: 'exportBibtex',
          payload: {
            bibcodes: missingPapers.map(p => p.bibcode),
            options: state.preferences || {}
          }
        });
        fallbackBibtex = exportResult.bibtex;

        const sep = bibtexContent && bibtexContent.trim() ? '\n\n' : '';
        const trimmed = bibtexContent ? bibtexContent.replace(/\s+$/, '') : '';
        return trimmed + sep + exportResult.bibtex.trimEnd() + '\n';
      }, {
        pickOnAmbiguous: (candidates) => promptSidebarBibPicker(candidates),
      });

      if (missingCount === 0) {
        setStatus('All library papers are already in .bib file');
      } else if (result.wrote) {
        setStatus(`Added ${missingCount} entries to ${result.target}`);
      } else if (fallbackBibtex) {
        await copyToClipboard(fallbackBibtex);
        setStatus(`Copied ${missingCount} entries to clipboard (paste manually)`);
      }
    } catch (error) {
      setError(`Sync failed: ${error.message}`);
    }
  }

  /**
   * Extract DOI / bibcode / arXiv identifiers from raw .bib text.
   * Pulled out of syncLibraryToBib so countMissingInBib can reuse it.
   */
  function extractExistingBibIdentifiers(bibtexContent) {
    const bibcodes = new Set();
    const dois = new Set();
    const arxivIds = new Set();

    const normalizeBibcode = (bc) => bc.replace(/\./g, '').toLowerCase();
    const normalizeArxivId = (id) => {
      const c = id.replace(/^arXiv:/i, '').trim().toLowerCase();
      return /^\d{4}\.\d{4,5}$/.test(c) ? c : null;
    };

    for (const m of bibtexContent.matchAll(/\/abs\/([A-Za-z0-9.]+)/gi)) {
      bibcodes.add(normalizeBibcode(m[1]));
    }
    for (const m of bibtexContent.matchAll(/doi\s*=\s*\{?\{?["']?([0-9][0-9./\-A-Za-z:]+)["']?\}?\}?/gi)) {
      const doi = m[1].replace(/[{}"']/g, '').trim();
      if (doi) dois.add(doi.toLowerCase());
    }
    for (const m of bibtexContent.matchAll(/eprint\s*=\s*[{"']?([^}"',]+)[}"']?/gi)) {
      const a = normalizeArxivId(m[1]);
      if (a) arxivIds.add(a);
    }
    for (const m of bibtexContent.matchAll(/arXiv[:\s]+(\d{4}\.\d{4,5})/gi)) {
      arxivIds.add(m[1].toLowerCase());
    }
    for (const m of bibtexContent.matchAll(/(?:eprint|arxiv|eid)[^=]*=\s*[{"']?(?:arXiv:)?(\d{4}\.\d{4,5})/gi)) {
      arxivIds.add(m[1].toLowerCase());
    }
    for (const m of bibtexContent.matchAll(/@\w+\s*\{\s*(\d{4}[A-Za-z&][^\s,]+)/g)) {
      const key = m[1];
      if (key.length >= 18 && key.length <= 20) bibcodes.add(normalizeBibcode(key));
      const ak = key.match(/^\d{4}arXiv(\d{4})(\d{5})[A-Za-z]$/i);
      if (ak) arxivIds.add(`${ak[1]}.${ak[2]}`.toLowerCase());
    }
    return { bibcodes, dois, arxivIds };
  }

  /**
   * A very small inline picker for flows that don't have a modal available
   * (sync-to-.bib). Shows a sidebar prompt and returns the chosen filename.
   */
  function promptSidebarBibPicker(candidates) {
    const msg = 'Multiple .bib files in this project. Pick one:\n\n  ' + candidates.join('\n  ');
    const choice = window.prompt(msg + '\n\nType the exact name:', candidates[0] || '');
    if (!choice) return Promise.resolve(null);
    return Promise.resolve(candidates.includes(choice) ? choice : candidates[0]);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
