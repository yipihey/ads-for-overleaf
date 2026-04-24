/**
 * Options page script
 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Load saved settings
  await loadSettings();

  // Event listeners
  document.getElementById('save-token').addEventListener('click', saveToken);
  document.getElementById('test-token').addEventListener('click', testToken);
  document.getElementById('toggle-token').addEventListener('click', toggleTokenVisibility);
  document.getElementById('clear-cache').addEventListener('click', clearCache);

  // Auto-save preferences on change
  document.getElementById('key-format').addEventListener('change', savePreferences);
  document.getElementById('journal-format').addEventListener('change', savePreferences);
  document.getElementById('max-authors').addEventListener('change', savePreferences);
  document.getElementById('cite-command').addEventListener('change', savePreferences);
  document.getElementById('citation-key-mode').addEventListener('change', savePreferences);
  document.getElementById('add-entry-to-bib').addEventListener('change', savePreferences);
  document.getElementById('dedupe-on-insert').addEventListener('change', savePreferences);
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['adsToken', 'preferences']);

  // Token
  if (result.adsToken) {
    document.getElementById('api-token').value = result.adsToken;
    showStatus('token-status', 'Token configured', 'success');
  }

  // Preferences
  const prefs = result.preferences || {};
  
  if (prefs.bibtexKeyFormat) {
    document.getElementById('key-format').value = prefs.bibtexKeyFormat;
  }
  
  if (prefs.journalFormat) {
    document.getElementById('journal-format').value = prefs.journalFormat;
  }
  
  if (prefs.maxAuthors) {
    document.getElementById('max-authors').value = prefs.maxAuthors;
  }
  
  if (prefs.citeCommand) {
    document.getElementById('cite-command').value = prefs.citeCommand;
  }

  document.getElementById('citation-key-mode').value = prefs.citationKeyMode || 'bibcode';
  document.getElementById('add-entry-to-bib').checked = prefs.addEntryToBibOnInsert !== false;
  document.getElementById('dedupe-on-insert').checked = prefs.dedupeOnInsert !== false;
}

async function saveToken() {
  const token = document.getElementById('api-token').value.trim();
  
  if (!token) {
    showStatus('token-status', 'Please enter a token', 'error');
    return;
  }

  showStatus('token-status', 'Validating...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'validateToken',
      payload: { token }
    });

    if (response.valid) {
      showStatus('token-status', 'Token saved and validated!', 'success');
    } else {
      showStatus('token-status', `Invalid token: ${response.error}`, 'error');
    }
  } catch (error) {
    showStatus('token-status', `Error: ${error.message}`, 'error');
  }
}

async function testToken() {
  const token = document.getElementById('api-token').value.trim();
  
  if (!token) {
    showStatus('token-status', 'Please enter a token first', 'error');
    return;
  }

  showStatus('token-status', 'Testing connection...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'validateToken',
      payload: { token }
    });

    if (response.valid) {
      showStatus('token-status', 'Connection successful! Token is valid.', 'success');
    } else {
      showStatus('token-status', `Connection failed: ${response.error}`, 'error');
    }
  } catch (error) {
    showStatus('token-status', `Error: ${error.message}`, 'error');
  }
}

function toggleTokenVisibility() {
  const input = document.getElementById('api-token');
  const btn = document.getElementById('toggle-token');
  
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁';
  }
}

async function savePreferences() {
  const prefs = {
    bibtexKeyFormat: document.getElementById('key-format').value || null,
    journalFormat: parseInt(document.getElementById('journal-format').value, 10),
    maxAuthors: parseInt(document.getElementById('max-authors').value, 10),
    citeCommand: document.getElementById('cite-command').value,
    citationKeyMode: document.getElementById('citation-key-mode').value,
    addEntryToBibOnInsert: document.getElementById('add-entry-to-bib').checked,
    dedupeOnInsert: document.getElementById('dedupe-on-insert').checked,
  };

  try {
    await chrome.runtime.sendMessage({
      action: 'setPreferences',
      payload: prefs
    });
  } catch (error) {
    console.error('Error saving preferences:', error);
  }
}

async function clearCache() {
  try {
    await chrome.runtime.sendMessage({ action: 'clearCaches' });
    alert('Cache cleared successfully!');
  } catch (error) {
    alert(`Error clearing cache: ${error.message}`);
  }
}

function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status ${type}`;
}
