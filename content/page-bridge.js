/**
 * ADS for Overleaf — Page Bridge (main-world script)
 *
 * Runs inside Overleaf's page (not the extension's isolated world) so we can
 * reach CodeMirror 6 EditorView instances directly. The content script talks
 * to this bridge via custom events so we don't depend on inline <script>
 * injection (CSP-fragile) or postMessage origin dances.
 *
 * Protocol
 *   window.dispatchEvent(new CustomEvent('ads4ol:request',
 *     { detail: { id, action, payload } }))
 *
 *   window.addEventListener('ads4ol:response',
 *     e => e.detail = { id, ok, result?, error? })
 *
 * Actions
 *   getActiveEditor          -> { text, from, to, fileName }
 *   replaceDocument          -> { text, expectedFileName?, expectedLength?,
 *                                 expectedHead?, expectedTail? }
 *   replaceRange             -> { from, to, insert, expectedFileName? }
 *   ping                     -> 'pong'   (readiness handshake)
 *
 * The write actions perform pre-flight guards so we never clobber a file the
 * user has switched to in between read and write.
 */
(function () {
  'use strict';

  if (window.__ADS4OL_BRIDGE_READY__) return;
  window.__ADS4OL_BRIDGE_READY__ = true;

  const REQUEST_EVENT = 'ads4ol:request';
  const RESPONSE_EVENT = 'ads4ol:response';

  window.addEventListener(REQUEST_EVENT, (ev) => {
    const detail = ev && ev.detail;
    if (!detail || !detail.id) return;
    const { id, action, payload } = detail;
    Promise.resolve()
      .then(() => dispatch(action, payload))
      .then((result) => reply(id, { ok: true, result }))
      .catch((err) => reply(id, { ok: false, error: String(err && err.message || err) }));
  });

  function reply(id, body) {
    window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: { id, ...body } }));
  }

  function dispatch(action, payload) {
    switch (action) {
      case 'ping':              return 'pong';
      case 'getActiveEditor':   return getActiveEditor();
      case 'replaceDocument':   return replaceDocument(payload || {});
      case 'replaceRange':      return replaceRange(payload || {});
      default:
        throw new Error('Unknown bridge action: ' + action);
    }
  }

  // ----------------------------------------------------------------------
  // CodeMirror discovery
  // ----------------------------------------------------------------------

  function findActiveEditorView() {
    const candidates = [];

    // Preferred: the .cm-editor nearest the current focus / explicitly focused.
    const active = document.activeElement;
    if (active && typeof active.closest === 'function') {
      const near = active.closest('.cm-editor');
      if (near) candidates.push(near);
    }
    const focused = document.querySelector('.cm-editor.cm-focused');
    if (focused) candidates.push(focused);

    // Fallback: every visible .cm-editor, largest first (the main source pane
    // is typically bigger than any mini-editor like the outline preview).
    const all = Array.from(document.querySelectorAll('.cm-editor')).filter(isVisible);
    all.sort((a, b) => area(b) - area(a));
    for (const el of all) {
      if (!candidates.includes(el)) candidates.push(el);
    }

    for (const el of candidates) {
      const view = readViewFromElement(el);
      if (view && view.state && view.state.doc && typeof view.dispatch === 'function') {
        return view;
      }
    }
    return null;
  }

  function readViewFromElement(el) {
    if (!el) return null;
    // CodeMirror 6 hangs the view off the root .cm-editor element as `cmView`.
    const cmView = el.cmView;
    if (cmView) {
      if (cmView.rootView && cmView.rootView.view) return cmView.rootView.view;
      if (cmView.view) return cmView.view;
      if (cmView.state && typeof cmView.dispatch === 'function') return cmView;
    }
    // Some builds expose a view via the .cm-content descendant.
    const content = el.querySelector && el.querySelector('.cm-content');
    if (content && content.cmView) {
      return content.cmView.view || content.cmView;
    }
    return null;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  // ----------------------------------------------------------------------
  // Active file name discovery (toolbar / breadcrumbs / active tab)
  // ----------------------------------------------------------------------

  const FILE_EXT_RE = /([A-Za-z0-9_.\-\/ ]+\.(?:tex|bib|sty|cls|bst|bbl|txt|md|csv|json|yaml|yml|py|js|ts))\b/i;

  function readActiveFileName() {
    const selectors = [
      '.ol-cm-breadcrumbs',
      '.ol-cm-toolbar-wrapper',
      '[role="tab"][aria-selected="true"]',
      '[role="tab"][data-active="true"]',
      '.file-tab.active',
      '.tab.active',
      '.file-tree [aria-selected="true"]',
      '.file-tree .selected',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const name = pickFileNameFromElement(el);
      if (name) return name;
    }
    return '';
  }

  function pickFileNameFromElement(el) {
    if (!(el instanceof Element)) return '';
    const own = matchFileName(el.textContent || '');
    if (own) return own;
    // Prefer the shortest matching descendant text — avoids pulling
    // whole-panel concatenations that accidentally contain a filename.
    const matches = [];
    for (const node of el.querySelectorAll('*')) {
      const m = matchFileName(node.textContent || '');
      if (m) matches.push(m);
    }
    matches.sort((a, b) => a.length - b.length);
    return matches[0] || '';
  }

  function matchFileName(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const m = s.match(FILE_EXT_RE);
    return m ? m[1].trim() : '';
  }

  // ----------------------------------------------------------------------
  // Actions
  // ----------------------------------------------------------------------

  function getActiveEditor() {
    const view = findActiveEditorView();
    if (!view) throw new Error('No active CodeMirror editor found');
    const sel = view.state.selection.main;
    return {
      text: view.state.doc.toString(),
      from: sel.from,
      to: sel.to,
      fileName: readActiveFileName(),
    };
  }

  function ensureFileName(expectedFileName) {
    if (!expectedFileName) return;
    const active = readActiveFileName();
    if (!active) throw new Error('Cannot confirm active file name');
    // Allow partial match — breadcrumbs can include parent folder prefix.
    if (active !== expectedFileName && !active.endsWith(expectedFileName) && !active.includes(expectedFileName)) {
      throw new Error('Active editor is ' + active + ', expected ' + expectedFileName);
    }
  }

  function ensureDocumentShape(view, guard) {
    if (!guard) return;
    const { expectedLength, expectedHead, expectedTail } = guard;
    const text = view.state.doc.toString();
    if (Number.isFinite(expectedLength) && text.length !== expectedLength) {
      throw new Error('Document length changed before write (got ' + text.length + ', expected ' + expectedLength + ')');
    }
    if (expectedHead && !text.startsWith(expectedHead)) {
      throw new Error('Document head changed before write');
    }
    if (expectedTail && !text.endsWith(expectedTail)) {
      throw new Error('Document tail changed before write');
    }
  }

  function replaceDocument(payload) {
    const view = findActiveEditorView();
    if (!view) throw new Error('No active CodeMirror editor found');
    ensureFileName(payload.expectedFileName);
    ensureDocumentShape(view, {
      expectedLength: payload.expectedLength,
      expectedHead: payload.expectedHead,
      expectedTail: payload.expectedTail,
    });
    const next = String(payload.text != null ? payload.text : '');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: { anchor: next.length },
      scrollIntoView: true,
    });
    view.focus();
    return { length: next.length };
  }

  function replaceRange(payload) {
    const view = findActiveEditorView();
    if (!view) throw new Error('No active CodeMirror editor found');
    ensureFileName(payload.expectedFileName);
    const from = Number(payload.from);
    const to = Number(payload.to);
    const insert = String(payload.insert != null ? payload.insert : '');
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('replaceRange requires numeric from/to');
    }
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
    view.focus();
    return { inserted: insert.length };
  }
})();
