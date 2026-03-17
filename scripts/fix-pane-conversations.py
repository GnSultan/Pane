#!/usr/bin/env python3
"""
Script to fix corrupted JSON conversation files in ~/.pane/conversations directory.
Handles common corruption patterns seen in Pane conversation files.
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path


def remove_non_printable(text):
    """Remove non-printable characters except for common whitespace."""
    # Keep tab, newline, carriage return
    return "".join(char for char in text if char.isprintable() or char in "\n\r\t")


def complete_json(content):
    """Try to complete JSON by adding missing closing braces and brackets."""
    open_braces = content.count("{")
    close_braces = content.count("}")
    open_brackets = content.count("[")
    close_brackets = content.count("]")

    result = content

    # Add missing closing braces
    if open_braces > close_braces:
        result += "}" * (open_braces - close_braces)

    # Add missing closing brackets
    if open_brackets > close_brackets:
        result += "]" * (open_brackets - close_brackets)

    return result


def truncate_to_last_valid(content):
    """Truncate content to the last valid JSON position."""
    # Find the last closing brace or bracket
    last_brace = content.rfind("}")
    last_bracket = content.rfind("]")
    last_close = max(last_brace, last_bracket)

    if last_close != -1:
        return content[: last_close + 1]

    return content


def fix_json(content, error):
    """Attempt to fix JSON based on specific error type."""
    error_msg = str(error)

    # Handle invalid control characters
    if "Invalid control character" in error_msg:
        return remove_non_printable(content)

    # Handle expecting ',' delimiter
    elif "Expecting ',' delimiter" in error_msg:
        pos = error.pos

        # Check if there's an extra quote at the error position
        if pos < len(content) and content[pos] == '"':
            # Remove the extra quote
            return content[:pos] + content[pos + 1 :]

        # Try to insert a comma
        return content[:pos] + "," + content[pos:]

    # Handle extra data
    elif "Extra data" in error_msg:
        pos = error.pos
        return content[:pos]

    # Handle unexpected character
    elif "Unexpected character" in error_msg:
        pos = error.pos
        if pos < len(content):
            # Remove the unexpected character
            return content[:pos] + content[pos + 1 :]

    return None


def try_fix_file(filepath):
    """Attempt to fix a single JSON file."""
    print(f"Processing: {filepath}")

    # Read the file
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"  ✗ Error reading file: {e}")
        return False

    # Create backup
    backup_path = filepath.with_suffix(filepath.suffix + ".bak")
    try:
        shutil.copy2(filepath, backup_path)
        print(f"  Created backup: {backup_path}")
    except Exception as e:
        print(f"  ✗ Error creating backup: {e}")
        return False

    # Try to parse the original content
    try:
        data = json.loads(content)
        print("  ✓ File is already valid JSON")
        return True
    except json.JSONDecodeError as e:
        print(f"  ✗ JSON decode error: {e.msg} at position {e.pos}")

    # Try multiple fix strategies
    fix_strategies = [
        ("Specific error fix", lambda c, e: fix_json(c, e)),
        ("Remove non-printable chars", lambda c, e: remove_non_printable(c)),
        ("Complete JSON structure", lambda c, e: complete_json(c)),
        ("Truncate to last valid", lambda c, e: truncate_to_last_valid(c)),
    ]

    current_content = content
    last_exception = None

    for strategy_name, strategy_func in fix_strategies:
        try:
            # Get the last exception for context
            if last_exception:
                fixed_content = strategy_func(current_content, last_exception)
            else:
                # Try to parse to get an exception
                try:
                    json.loads(current_content)
                    # If we get here, it's valid
                    print(f"  ✓ Fixed with {strategy_name}")
                    break
                except json.JSONDecodeError as e:
                    last_exception = e
                    fixed_content = strategy_func(current_content, e)

            if fixed_content is None or fixed_content == current_content:
                continue

            # Try the fixed content
            data = json.loads(fixed_content)
            current_content = fixed_content
            print(f"  ✓ Fixed with {strategy_name}")
            break

        except json.JSONDecodeError as e:
            last_exception = e
            continue
        except Exception as e:
            print(f"  ✗ Error during {strategy_name}: {e}")
            continue

    # Try to parse the final content
    try:
        data = json.loads(current_content)

        # Write the fixed content back
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(f"  ✓ Successfully fixed and saved")

        # Verify the fix
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                json.load(f)
            print(f"  ✓ Verification passed")
            return True
        except json.JSONDecodeError as e:
            print(f"  ✗ Verification failed: {e}")
            # Restore from backup
            try:
                shutil.copy2(backup_path, filepath)
                print(f"  Restored from backup")
            except Exception as restore_error:
                print(f"  ✗ Error restoring from backup: {restore_error}")
            return False

    except json.JSONDecodeError as e:
        print(f"  ✗ Could not fix file: {e.msg}")
        return False


def main():
    """Main function to fix all conversation files."""
    # Get the conversations directory
    home_dir = Path.home()
    conversations_dir = home_dir / ".pane" / "conversations"

    if not conversations_dir.exists():
        print(f"Conversations directory not found: {conversations_dir}")
        return

    # Find all JSON files
    json_files = list(conversations_dir.glob("*.json"))

    if not json_files:
        print(f"No JSON files found in {conversations_dir}")
        return

    print(f"Found {len(json_files)} JSON files in {conversations_dir}")
    print("=" * 60)

    # Process each file
    fixed_count = 0
    failed_count = 0

    for json_file in json_files:
        print()
        if try_fix_file(json_file):
            fixed_count += 1
        else:
            failed_count += 1

    print("\n" + "=" * 60)
    print("Summary:")
    print(f"  Fixed: {fixed_count}")
    print(f"  Failed: {failed_count}")
    print(f"  Total: {len(json_files)}")

    if failed_count > 0:
        print("\nNote: Backup files have been created with .bak extension")
        print("You can manually inspect the corrupted files or restore from backups.")


if __name__ == "__main__":
    main()
