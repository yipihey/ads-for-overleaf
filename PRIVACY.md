# Privacy Policy

**ADS for Overleaf Browser Extension**

Last updated: January 2026

## Overview

ADS for Overleaf is committed to protecting your privacy. This policy explains what data the extension accesses, how it's used, and how it's protected.

## Data Collection

### What We Collect

**Nothing.** This extension does not collect, transmit, or store any personal data on external servers.

### What We Store Locally

The following data is stored locally in your browser using the browser's extension storage API:

| Data | Purpose | Storage Location |
|------|---------|-----------------|
| ADS API Token | Authenticate with ADS servers | Local browser storage |
| User Preferences | Remember your settings | Local browser storage |
| Library Cache | Improve performance | Local browser storage |

This data never leaves your device except when making authenticated requests to the ADS API.

## Data Transmission

The extension communicates only with:

- **api.adsabs.harvard.edu** — The official NASA ADS API

All communication uses HTTPS encryption. Your API token is sent only to ADS servers for authentication purposes.

The extension does **not** communicate with:

- Any analytics services
- Any tracking services
- Any third-party servers
- The extension developers

## Data Access

### What the Extension Can Access

- **Overleaf.com pages** — To inject the citation panel UI
- **ADS API** — To fetch your libraries and search results

### What the Extension Cannot Access

- Your Overleaf documents
- Your browsing history
- Other websites
- Your personal files

## Third-Party Services

### NASA ADS

When you use this extension, you interact with NASA ADS through their API. Your use of ADS is subject to their privacy policy and terms of service:

- [ADS Privacy Policy](https://ui.adsabs.harvard.edu/help/privacy/)
- [ADS Terms of Use](https://ui.adsabs.harvard.edu/help/terms/)

### Overleaf

The extension injects UI elements into Overleaf pages. Your use of Overleaf is subject to their privacy policy:

- [Overleaf Privacy Policy](https://www.overleaf.com/legal)

## Data Retention

- **API Token**: Stored until you remove it or uninstall the extension
- **Preferences**: Stored until you reset them or uninstall the extension
- **Cache**: Automatically expires after 5 minutes; cleared on "Clear Cache" action

## Your Rights

You can:

- **View your data**: Check extension storage in browser developer tools
- **Delete your data**: Use "Clear Cache" in settings or uninstall the extension
- **Revoke API access**: Delete your token in extension settings and/or regenerate it on ADS

## Security

- API tokens are stored in local browser storage (not synced to cloud)
- All API communication uses HTTPS
- The extension has minimal permissions (only what's needed to function)

## Children's Privacy

This extension is not directed at children under 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this policy occasionally. Significant changes will be noted in the extension's changelog.

## Contact

For privacy concerns or questions:

- Open an issue on [GitHub](https://github.com/yipihey/ads-for-overleaf/issues)
- Email: ads-for-overleaf@tomabel.org

## Open Source

This extension is open source. You can review the complete source code at:
https://github.com/yipihey/ads-for-overleaf
