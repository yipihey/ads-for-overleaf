# Changelog

All notable changes to ADS for Overleaf will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Auto-sync .bib file with ADS library
- Enhanced cite-key autocomplete
- arXiv to published paper detection

## [1.4.0] - 2026-04-24

### Added
- **File-agnostic `.bib` targeting.** Import to ADS, Add to .bib, and the
  unread-in-bib badge now work from any file in the project. The extension
  resolves the target `.bib` from `\bibliography{}` / `\addbibresource{}`
  directives, conventional filenames, or a per-project override, and
  temporarily switches editors via the file tree (then switches back).
- **Page bridge** (`content/page-bridge.js`) for reliable CodeMirror 6
  reads/writes through a `web_accessible_resources` script. Document-shape
  and active-filename guards refuse to clobber the editor if the user
  switches files mid-operation.
- **Context-aware search.** New "From context" icon next to the sidebar
  search box reads the sentence around your cursor in the active `.tex`,
  builds batched `title:(...) OR abstract:(...)` queries, and reranks
  results by keyword overlap (citation count as a tiebreak). Matched
  keywords show as chips under each result.
- **Smart citation keys.** New Options setting "Citation Key Style" with
  four modes: `bibcode` (default, unchanged), `authoryear` (`Stone2020`),
  `informative` (`Stone20_athena_framework`), and `typed` (sanitise what
  the user typed). Collision suffixes `a`, `b`, ..., then numeric.
- **Duplicate-on-insert.** When enabled, clicking a paper checks the target
  `.bib` by DOI → bibcode → arXiv → normalised title; if the paper is
  already present, the existing cite key is reused. Otherwise the BibTeX
  is fetched, keyed per the selected style, and appended to the `.bib`.
- **Persistent resolution cache** (30-day TTL) keyed by DOI / bibcode /
  arXiv / title+author+year. Re-running an import on a mostly-unchanged
  `.bib` now skips ADS entirely for cached entries.

### Changed
- **BibTeX resolver batches identifier lookups.** A new `resolveEntriesBatched`
  path groups entries by identifier and resolves each group with Solr
  `OR` queries of up to 100 terms per call. For a 2 800-entry bibliography
  this cuts ADS API queries from roughly 7 000 to ~2 000 on a cold run
  and to near-zero on a warm one.
- **Import chunking overhauled** to stay under Chrome MV3's message-port
  timeout: scan chunks are now driven from the content script (200 entries
  per round-trip), and "Create Library" / "Add to Library" confirmation
  splits bibcodes into 400-per-message batches. No more "message channel
  closed before a response was received" on large imports.
- **Title+author fallback hardened.** LaTeX accents (`\v{s}`, `\'e`,
  `{\AA}`, ...) are stripped before matching, punctuation that breaks Solr
  (`++`, `-`, `:`, `?`) is sanitised out, and the query uses progressive
  relaxation (strict → no year → fewer title words) before giving up.
- **`createLibrary` chunks internally** — creates with the first ≤500
  bibcodes, then adds the rest via `addToLibrary` loops.
- Default `citeCommand` is still `\cite`; no behaviour change for users
  who don't touch the new settings.

### Fixed
- Hundreds of entries in large `.bib` files that previously fell through
  unresolved because of LaTeX accents in author names, LaTeX punctuation
  leaking into title terms, or over-strict exact-title-word matching.
- Large imports (1 000+ entries) no longer surface "A listener indicated
  an asynchronous response by returning true, but the message channel
  closed before a response was received" from either the scan or the
  add-to-library phase.
- ADS daily-quota exhaustion on repeated imports — the resolution cache
  now makes re-scans essentially free.

## [1.0.0] - 2026-01-12

### Added
- Initial release
- Browse ADS personal libraries in Overleaf
- Search all of ADS from within Overleaf
- One-click citation insertion
- BibTeX export (copy to clipboard)
- Configurable citation key formats
- Configurable journal formats
- Multiple citation command styles (\cite, \citep, \citet, etc.)
- Keyboard shortcut (Ctrl+Shift+C / Cmd+Shift+C)
- Dark mode support
- Chrome and Firefox support

### Security
- API tokens stored locally only
- All communication over HTTPS
- No analytics or tracking

[Unreleased]: https://github.com/yipihey/ads-for-overleaf/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/yipihey/ads-for-overleaf/releases/tag/v1.4.0
[1.0.0]: https://github.com/yipihey/ads-for-overleaf/releases/tag/v1.0.0
