# ADS for Overleaf

<p align="center">
  <img src="icons/icon.svg" alt="ADS for Overleaf Logo" width="128" height="128">
</p>

[![Download Latest Release](https://img.shields.io/github/v/release/yipihey/ads-for-overleaf?label=Download&style=for-the-badge)](https://github.com/yipihey/ads-for-overleaf/releases/latest)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub Release](https://img.shields.io/github/v/release/yipihey/ads-for-overleaf)](https://github.com/yipihey/ads-for-overleaf/releases/latest)

Connect your NASA ADS libraries directly to Overleaf. Search, cite, and export BibTeX without leaving the editor.

![ADS for Overleaf Screenshot](docs/screenshot.png)

## Features

- 📚 **Browse ADS Libraries** — Access all your personal ADS libraries from within Overleaf
- 🔍 **Search ADS** — Find papers across all of ADS without leaving your document
- 📝 **One-Click Citations** — Insert `\cite{}` commands at your cursor with a single click
- 📋 **Export BibTeX** — Copy or download BibTeX for any paper or entire library
- ⌨️ **Keyboard Shortcut** — Quick access with `Ctrl+Shift+C` (or `Cmd+Shift+C` on Mac)
- 🎨 **Dark Mode Support** — Automatically adapts to your system preferences

## Installation

### Chrome / Edge / Brave

1. Download the latest release from [Releases](https://github.com/yipihey/ads-for-overleaf/releases)
2. Unzip the file
3. Go to `chrome://extensions/`
4. Enable "Developer mode" (top right)
5. Click "Load unpacked" and select the unzipped folder

*Coming soon to Chrome Web Store*

### Firefox

1. Download the latest release from [Releases](https://github.com/yipihey/ads-for-overleaf/releases)
2. Go to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select any file in the unzipped folder

*Coming soon to Firefox Add-ons*

## Setup

1. **Get your ADS API token**
   - Go to [ADS Token Settings](https://ui.adsabs.harvard.edu/user/settings/token)
   - Log in with your ADS account
   - Copy your API token

2. **Configure the extension**
   - Click the ADS for Overleaf icon in your browser toolbar
   - Click "Set up now" or go to Settings
   - Paste your API token and click "Save Token"

3. **Start using it!**
   - Open any project on [Overleaf](https://www.overleaf.com)
   - Click the "ADS" button in the toolbar (or press `Ctrl+Shift+C`)
   - Browse your libraries or search for papers
   - Click any paper to insert a citation

## Usage

### Inserting Citations

1. Place your cursor where you want the citation
2. Open the ADS panel (`Ctrl+Shift+C`)
3. Search or browse to find your paper
4. Click the paper to insert `\cite{bibcode}`

### Exporting BibTeX

1. Find the paper in the ADS panel
2. Click the "BibTeX" button
3. The BibTeX entry is copied to your clipboard
4. Paste into your `.bib` file

### Customization

In Settings, you can configure:

- **Citation key format** — Choose between bibcode, Author2024, Author:2024, etc.
- **Journal format** — AASTeX macros, full names, or abbreviations
- **Citation command** — `\cite`, `\citep`, `\citet`, etc.

## Privacy

This extension:

- ✅ Stores your ADS API token locally in your browser
- ✅ Only communicates with `api.adsabs.harvard.edu`
- ❌ Does not collect any personal data
- ❌ Does not use analytics or tracking

Your API token never leaves your device except to authenticate with the official ADS servers.

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## Development

### Prerequisites

- Node.js 18+ (optional, for build tools)
- A browser with developer mode enabled

### Running Locally

```bash
# Clone the repository
git clone https://github.com/yipihey/ads-for-overleaf.git
cd ads-for-overleaf

# Load in Chrome
# 1. Go to chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked"
# 4. Select the ads-for-overleaf folder
```

### Project Structure

```
ads-for-overleaf/
├── manifest.json          # Extension manifest
├── background/            # Service worker
├── content/               # Content scripts (injected into Overleaf)
├── popup/                 # Browser toolbar popup
├── options/               # Settings page
├── lib/                   # Shared libraries
├── styles/                # CSS styles
└── icons/                 # Extension icons
```

### Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

## Related Projects

- [imbib](https://github.com/yipihey/imbib) — Cross-platform scientific publication manager
- [adstex](https://github.com/yymao/adstex) — Command-line BibTeX generator from ADS
- [NASA ADS](https://ui.adsabs.harvard.edu/) — The Astrophysics Data System

## Acknowledgments

This extension uses the NASA ADS logo under the [Creative Commons Attribution 4.0 License](http://creativecommons.org/licenses/by/4.0/).

This extension is not affiliated with NASA or the Smithsonian Astrophysical Observatory. 
NASA ADS is a service of the Smithsonian Astrophysical Observatory under NASA Cooperative Agreement 80NSSC21M0056.

## License

MIT License — see [LICENSE](LICENSE) for details.

---

**Made with ❤️ for the astronomy community**
