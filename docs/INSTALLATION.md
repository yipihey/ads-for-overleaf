# Installation Guide

This guide provides detailed instructions for installing ADS for Overleaf on all supported browsers.

## Quick Start

1. Download the latest release zip from [GitHub Releases](https://github.com/yipihey/ads-for-overleaf/releases)
2. Unzip the file
3. Load the extension in your browser (see browser-specific instructions below)
4. Get your [ADS API token](https://ui.adsabs.harvard.edu/user/settings/token) and configure it in the extension settings

---

## Browser-Specific Instructions

### Google Chrome

1. **Download and unzip** the latest release
2. **Open Chrome** and navigate to `chrome://extensions/`
3. **Enable Developer mode** using the toggle in the top-right corner
4. **Click "Load unpacked"** button
5. **Select the unzipped folder** (the one containing `manifest.json`)
6. The extension icon should appear in your toolbar

**Troubleshooting:**
- If you don't see the icon, click the puzzle piece icon in the toolbar and pin "ADS for Overleaf"
- If you get a "manifest version" error, make sure you downloaded the Chrome version

### Microsoft Edge

1. **Download and unzip** the latest release
2. **Open Edge** and navigate to `edge://extensions/`
3. **Enable Developer mode** using the toggle in the left sidebar
4. **Click "Load unpacked"**
5. **Select the unzipped folder**

### Brave Browser

1. **Download and unzip** the latest release
2. **Open Brave** and navigate to `brave://extensions/`
3. **Enable Developer mode** toggle
4. **Click "Load unpacked"**
5. **Select the unzipped folder**

### Firefox

1. **Download and unzip** the latest release
2. **Open Firefox** and navigate to `about:debugging#/runtime/this-firefox`
3. **Click "Load Temporary Add-on..."**
4. **Navigate to the unzipped folder** and select `manifest.json`

**Note:** Firefox loads extensions temporarily. You'll need to reload after restarting Firefox.

For permanent installation, the extension will be available on Firefox Add-ons store (coming soon).

---

## Configuration

### Step 1: Get Your ADS API Token

1. Go to [ADS Token Settings](https://ui.adsabs.harvard.edu/user/settings/token)
2. Log in with your ADS account (create one if needed at [NASA ADS](https://ui.adsabs.harvard.edu/))
3. Your token will be displayed. Copy it.

**Important:** Keep your token private. It provides access to your ADS account.

### Step 2: Configure the Extension

1. Click the **ADS for Overleaf icon** in your browser toolbar
2. Click **"Set up now"** or the **Settings** (⚙️) icon
3. Paste your API token into the **"ADS API Token"** field
4. Click **"Save Token"**

A green checkmark will appear if the token is valid.

### Step 3: (Optional) Customize Settings

You can configure:

| Setting | Options | Description |
|---------|---------|-------------|
| Citation Key Format | Bibcode, Author2024, Author:2024, Author:2024:Journal | How citation keys are generated |
| Citation Command | `\cite`, `\citep`, `\citet`, `\citeauthor` | The LaTeX command to insert |
| Journal Format | AASTeX macros, Full names, Abbreviations | How journal names appear in BibTeX |
| Max Authors | Number | Authors to include before "et al." |

---

## Using the Extension

### Opening the Panel

Three ways to open the ADS panel:

1. **Click the "ADS" button** in the Overleaf toolbar
2. **Use keyboard shortcut**: `Ctrl+Shift+C` (Windows/Linux) or `Cmd+Shift+C` (Mac)
3. **Click the extension icon** in your browser toolbar

### Inserting Citations

1. Place your cursor where you want the citation
2. Open the ADS panel
3. Either:
   - Select a library and click a paper, or
   - Search for a paper and click it
4. The citation command is inserted at your cursor

### Copying BibTeX

1. Find the paper in the panel
2. Click the **"BibTeX"** button
3. The BibTeX is copied to your clipboard
4. Paste into your `.bib` file

---

## Updating the Extension

When a new version is released:

1. Download the new release zip
2. Unzip to a **new folder** (don't overwrite)
3. In your browser's extensions page:
   - Remove the old version
   - Load the new version
4. Your settings and token are preserved (stored in browser)

---

## Troubleshooting

### Extension doesn't appear on Overleaf

- Make sure you're on `www.overleaf.com` (not a custom domain)
- Refresh the Overleaf page after installing
- Check that the extension is enabled in your browser's extension settings

### "API token not configured" error

- Open extension settings and enter your token
- Make sure you copied the full token (40 characters)
- Try generating a new token at [ADS Token Settings](https://ui.adsabs.harvard.edu/user/settings/token)

### Libraries not loading

- Check your internet connection
- Verify your token is valid at [ADS](https://ui.adsabs.harvard.edu/)
- Try clicking the refresh button (↻) in the panel
- Check browser console for errors (F12 → Console)

### Citation not inserting

- Make sure your cursor is in the editor (click in the document first)
- Try using the keyboard shortcut instead
- If using Firefox, the clipboard fallback should work

### "Rate limit exceeded" error

- Wait a few seconds and try again
- ADS limits requests; the extension handles this automatically

---

## Security Notes

- Your API token is stored **locally** in your browser using the extension storage API
- The token is **never** sent anywhere except to `api.adsabs.harvard.edu`
- No analytics, tracking, or telemetry is collected
- You can revoke your token anytime at [ADS settings](https://ui.adsabs.harvard.edu/user/settings/token)

---

## Uninstalling

1. Go to your browser's extensions page
2. Find "ADS for Overleaf"
3. Click "Remove" or the trash icon
4. (Optional) Your ADS API token remains valid; revoke it at ADS if desired

---

## Getting Help

- **Bug reports**: [GitHub Issues](https://github.com/yipihey/ads-for-overleaf/issues)
- **Questions**: Open a GitHub issue or discussion
- **Feature requests**: Open a GitHub issue with the "enhancement" label

---

## Building from Source

For developers who want to modify the extension:

```bash
# Clone the repository
git clone https://github.com/yipihey/ads-for-overleaf.git
cd ads-for-overleaf

# (Optional) Set up shared library for development
cd lib
ln -s ../../shared-ads-lib/dist/esm shared-ads-lib
cd ..

# Load directly in browser - no build step required!
```

The extension uses vanilla JavaScript and doesn't require a build step.
