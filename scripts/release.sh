#!/bin/bash
# Release script for ADS for Overleaf
# Creates a clean zip file for distribution

set -e

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Extract version from manifest.json
VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')

if [ -z "$VERSION" ]; then
    echo "Error: Could not extract version from manifest.json"
    exit 1
fi

echo "Building release for ADS for Overleaf v$VERSION"

# Create build directory
BUILD_DIR="$PROJECT_ROOT/build"
RELEASE_NAME="ads-for-overleaf-v$VERSION"
RELEASE_DIR="$BUILD_DIR/$RELEASE_NAME"
ZIP_FILE="$BUILD_DIR/$RELEASE_NAME.zip"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$RELEASE_DIR"

# Copy extension files (excluding dev files)
echo "Copying files..."

# Core files
cp manifest.json "$RELEASE_DIR/"
cp -r background "$RELEASE_DIR/"
cp -r content "$RELEASE_DIR/"
cp -r icons "$RELEASE_DIR/"
cp -r lib "$RELEASE_DIR/"
cp -r options "$RELEASE_DIR/"
cp -r popup "$RELEASE_DIR/"
cp -r styles "$RELEASE_DIR/"

# Locales if they exist
if [ -d "_locales" ]; then
    cp -r _locales "$RELEASE_DIR/"
fi

# Documentation
cp README.md "$RELEASE_DIR/"
cp LICENSE "$RELEASE_DIR/" 2>/dev/null || echo "No LICENSE file"
cp PRIVACY.md "$RELEASE_DIR/" 2>/dev/null || echo "No PRIVACY.md file"

# Remove any dev/test files that might have been copied
find "$RELEASE_DIR" -name "*.test.js" -delete 2>/dev/null || true
find "$RELEASE_DIR" -name "*.spec.js" -delete 2>/dev/null || true
find "$RELEASE_DIR" -name ".DS_Store" -delete 2>/dev/null || true

# Create zip
echo "Creating zip archive..."
cd "$BUILD_DIR"
zip -r "$RELEASE_NAME.zip" "$RELEASE_NAME" -x "*.DS_Store"

# Verify
if [ -f "$ZIP_FILE" ]; then
    SIZE=$(du -h "$ZIP_FILE" | cut -f1)
    echo ""
    echo "Release created successfully!"
    echo "  File: $ZIP_FILE"
    echo "  Size: $SIZE"
    echo ""
    echo "To create a GitHub release:"
    echo "  git tag v$VERSION"
    echo "  git push origin v$VERSION"
else
    echo "Error: Failed to create zip file"
    exit 1
fi
