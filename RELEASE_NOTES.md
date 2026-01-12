# ADS for Overleaf v1.0.0

Initial public release of ADS for Overleaf - a browser extension that integrates NASA ADS with Overleaf for seamless citation management.

## Features

### Core Functionality
- **Browse ADS Libraries** — Access all your personal NASA ADS libraries directly within Overleaf
- **Search ADS** — Find papers across the entire ADS database without leaving your document
- **One-Click Citations** — Insert `\cite{}` commands at your cursor with a single click
- **BibTeX Export** — Copy BibTeX entries to clipboard instantly

### Customization
- **Citation Key Formats** — Choose between bibcode, Author2024, Author:2024, Author:2024:Journal
- **Citation Commands** — Use `\cite`, `\citep`, `\citet`, or any custom command
- **Journal Formats** — AASTeX macros, full names, or abbreviations

### Usability
- **Keyboard Shortcut** — Quick access with `Ctrl+Shift+C` (or `Cmd+Shift+C` on Mac)
- **Full Accessibility** — ARIA labels, keyboard navigation, screen reader support
- **Dark Mode Ready** — Adapts to your system preferences

### Technical
- **Manifest V3** — Modern Chrome extension architecture
- **Rate Limiting** — Automatic handling of ADS API limits
- **Offline Caching** — Recent searches cached for faster access

## Installation

### Chrome / Edge / Brave
1. Download `ads-for-overleaf-v1.0.0.zip` below
2. Unzip the file
3. Go to `chrome://extensions/` (or `edge://extensions/` or `brave://extensions/`)
4. Enable "Developer mode"
5. Click "Load unpacked" and select the unzipped folder

### Firefox
1. Download `ads-for-overleaf-v1.0.0.zip` below
2. Unzip the file
3. Go to `about:debugging#/runtime/this-firefox`
4. Click "Load Temporary Add-on"
5. Select `manifest.json` in the unzipped folder

## Setup

1. Get your API token from [ADS Token Settings](https://ui.adsabs.harvard.edu/user/settings/token)
2. Click the ADS for Overleaf icon in your browser
3. Enter your token in Settings
4. Open any Overleaf project and click the ADS button!

See the [full installation guide](https://github.com/yipihey/ads-for-overleaf/blob/main/docs/INSTALLATION.md) for detailed instructions.

## Privacy

- Your API token is stored locally in your browser
- No analytics, tracking, or telemetry
- Only communicates with `api.adsabs.harvard.edu`

---

**Made with ❤️ for the astronomy community**
