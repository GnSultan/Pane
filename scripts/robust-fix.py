#!/usr/bin/env python3
"""
Robust fix for corrupted Pane conversation files.
Handles incomplete JSON, null bytes, and malformed structure.
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path


def find_last_valid_json_structure(content):
    """
    Find the last valid JSON structure in corrupted content.
    Returns the content up to the last valid closing bracket/brace.
    """
    # Track bracket/brace nesting
    stack = []
    last_valid_pos = -1
    i = 0

    while i < len(content):
        char = content[i]

        # Skip escaped characters
        if char == '\\' and i + 1 < len(content):
            i += 2
            continue

        # Track brackets and braces
        if char in '{[':
            stack.append(char)
        elif char in '}]':
            if stack:
                stack.pop()
                # If stack is empty, we have a complete structure
                if not stack:
                    last_valid_pos = i
        i += 1

    if last_valid_pos >= 0:
        return content[:last_valid_pos + 1]
    return None


def clean_corrupted_content(content):
    """Clean corrupted content by removing null bytes and invalid control characters."""
    # Remove null bytes
    content = content.replace('\x00', '')

    # Remove other control characters except common ones
    cleaned = []
    for char in content:
        if char.isprintable() or char in '\n\r\t':
            cleaned.append(char)
        else:
            # Replace non-printable characters with space
            cleaned.append(' ')

    return ''.join(cleaned)


def fix_conversation_file(filepath):
    """Fix a corrupted conversation JSON file."""
    print(f"\nProcessing {filepath.name}...")

    # Create backup
    backup_path = filepath.with_suffix(filepath.suffix + ".robust.bak")
    try:
        shutil.copy2(filepath, backup_path)
        print(f"  Created backup: {backup_path}")
    except Exception as e:
        print(f"  ✗ Error creating backup: {e}")
        return False

    # Read the file
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except Exception as e:
        print(f"  ✗ Error reading file: {e}")
        return False

    original_size = len(content)
    print(f"  Original size: {original_size:,} bytes")

    # Step 1: Clean the content
    cleaned_content = clean_corrupted_content(content)
    print(f"  Cleaned size: {len(cleaned_content):,} bytes")

    # Step 2: Try to find valid JSON structure
    valid_json = find_last_valid_json_structure(cleaned_content)

    if not valid_json:
        print(f"  ✗ Could not find valid JSON structure")
        # Try one more approach: look for the last closing bracket
        last_bracket = cleaned_content.rfind(']')
        last_brace = cleaned_content.rfind('}')
        last_close = max(last_bracket, last_brace)

        if last_close >= 0:
            valid_json = cleaned_content[:last_close + 1]
            print(f"  Found last closing bracket at position {last_close}")
        else:
            return False

    # Step 3: Try to parse the JSON
    try:
        data = json.loads(valid_json)
        print(f"  ✓ Successfully parsed JSON")

        # Write back with proper formatting
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(f"  ✓ Successfully fixed {filepath.name}")
        print(f"    - Messages: {len(data.get('messages', []))}")
        print(f"    - Timestamp: {data.get('timestamp', 'N/A')}")
        return True

    except json.JSONDecodeError as e:
        print(f"  ✗ JSON decode error: {e}")

        # Try to fix common JSON issues
        try:
            # Look for missing commas or brackets
            # Pattern: closing brace/bracket followed by another value without comma
            fixed_content = re.sub(r'(\}\s*)([\"\{\[])', r'\1, \2', valid_json)
            fixed_content = re.sub(r'(\]\s*)([\"\{\[])', r'\1, \2', fixed_content)

            # Try parsing again
            data = json.loads(fixed_content)

            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)

            print(f"  ✓ Fixed using pattern matching")
            return True

        except Exception as e2:
            print(f"  ✗ Could not fix: {e2}")
            print(f"    Attempted to fix: {str(e)}")

            # Restore from backup
            try:
                shutil.copy2(backup_path, filepath)
                print(f"  Restored original from backup")
            except Exception as e3:
                print(f"  ✗ Error restoring from backup: {e3}")

            return False


def main():
    """Main function."""
    home_dir = Path.home()
    conversations_dir = home_dir / ".pane" / "conversations"

    if not conversations_dir.exists():
        print(f"Conversations directory not found: {conversations_dir}")
        return

    # Files to fix (based on the error logs)
    files_to_fix = [
        "punk-record.json",
        "pulse.json",
        "aslam-portfolio.json"
    ]

    print("Robust fix for corrupted Pane conversation files")
    print("=" * 60)

    fixed_count = 0
    failed_count = 0

    for filename in files_to_fix:
        filepath = conversations_dir / filename

        if not filepath.exists():
            print(f"\nFile not found: {filepath}")
            continue

        if fix_conversation_file(filepath):
            fixed_count += 1
        else:
            failed_count += 1

    print("\n" + "=" * 60)
    print(f"Summary:")
    print(f"  Fixed: {fixed_count}")
    print(f"  Failed: {failed_count}")
    print(f"  Total: {len(files_to_fix)}")

    if failed_count > 0:
        print("\nSome files could not be fixed automatically.")
        print("Backup files have been created with .robust.bak extension.")
        print("You may need to manually inspect these files or restore from an earlier backup.")


if __name__ == "__main__":
    main()