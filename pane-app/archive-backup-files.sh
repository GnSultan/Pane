#!/bin/bash

# Archive backup files from conversations directory

CONV_DIR="$HOME/.pane/conversations"
ARCHIVE_DIR="$CONV_DIR/archived"

echo "Creating archive directory: $ARCHIVE_DIR"
mkdir -p "$ARCHIVE_DIR"

echo "Archiving backup files..."
mv "$CONV_DIR"/*.backup* "$ARCHIVE_DIR/" 2>/dev/null || true
mv "$CONV_DIR"/*.bak "$ARCHIVE_DIR/" 2>/dev/null || true
mv "$CONV_DIR"/*.compressed* "$ARCHIVE_DIR/" 2>/dev/null || true
mv "$CONV_DIR"/*.test* "$ARCHIVE_DIR/" 2>/dev/null || true
mv "$CONV_DIR"/*.pre-compress* "$ARCHIVE_DIR/" 2>/dev/null || true

echo "Archive complete. Files in $ARCHIVE_DIR:"
ls -lh "$ARCHIVE_DIR/"
