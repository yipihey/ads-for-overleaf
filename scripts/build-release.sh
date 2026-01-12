#!/bin/bash
#
# Build script for ADS for Overleaf release
#
# Usage: ./scripts/build-release.sh [version]
# Example: ./scripts/build-release.sh 1.0.0
#

set -e

VERSION=${1:-$(grep '"version"' manifest.json | sed 's/.*"version": "\([^"]*\)".*/\1/')}
RELEASE_NAME="ads-for-overleaf-v${VERSION}"
RELEASE_DIR="releases/${RELEASE_NAME}"
SHARED_LIB_DIR="../shared-ads-lib"

echo "Building ADS for Overleaf v${VERSION}..."

# Check if shared-ads-lib exists
if [ ! -d "$SHARED_LIB_DIR" ]; then
    echo "Error: shared-ads-lib not found at $SHARED_LIB_DIR"
    echo "Please clone or symlink shared-ads-lib next to this project"
    exit 1
fi

# Build shared-ads-lib if needed
if [ ! -d "$SHARED_LIB_DIR/dist/esm" ]; then
    echo "Building shared-ads-lib..."
    cd "$SHARED_LIB_DIR"
    npm install
    npm run build
    cd -
fi

# Clean previous release
rm -rf "$RELEASE_DIR" "${RELEASE_DIR}.zip"
mkdir -p "$RELEASE_DIR"

# Copy extension files (preserving directory structure)
echo "Copying extension files..."
cp manifest.json "$RELEASE_DIR/"
cp -R background "$RELEASE_DIR/"
cp -R content "$RELEASE_DIR/"
cp -R popup "$RELEASE_DIR/"
cp -R options "$RELEASE_DIR/"
cp -R styles "$RELEASE_DIR/"
cp -R icons "$RELEASE_DIR/"
cp -R _locales "$RELEASE_DIR/"

# Copy lib files (excluding symlink)
mkdir -p "$RELEASE_DIR/lib"
cp lib/ads-api.js "$RELEASE_DIR/lib/"
cp lib/bibtex-utils.js "$RELEASE_DIR/lib/"
cp lib/browser-polyfill.js "$RELEASE_DIR/lib/"
cp lib/storage.js "$RELEASE_DIR/lib/"
cp lib/shared-import.js "$RELEASE_DIR/lib/"

# Copy shared-ads-lib dist files
echo "Copying shared-ads-lib..."
mkdir -p "$RELEASE_DIR/lib/shared-ads-lib"
cp "$SHARED_LIB_DIR/dist/esm/"*.js "$RELEASE_DIR/lib/shared-ads-lib/"

# Copy documentation
cp README.md "$RELEASE_DIR/"
cp LICENSE "$RELEASE_DIR/"
cp PRIVACY.md "$RELEASE_DIR/"

# Create zip
echo "Creating zip archive..."
cd releases
zip -r "${RELEASE_NAME}.zip" "${RELEASE_NAME}"
cd -

echo ""
echo "Release built successfully!"
echo "  Directory: ${RELEASE_DIR}"
echo "  Archive:   releases/${RELEASE_NAME}.zip"
echo ""
echo "To create a GitHub release:"
echo "  gh release create v${VERSION} releases/${RELEASE_NAME}.zip --title 'v${VERSION}' --notes-file RELEASE_NOTES.md"
