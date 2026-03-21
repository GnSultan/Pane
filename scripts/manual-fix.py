#!/usr/bin/env python3
"""
Manual fix for specific corrupted Pane conversation files.
Targeted fixes for files that automatic repair couldn't handle.
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path


def fix_punk_record(filepath):
    """Fix punk-record.json which ends with extra data after closing bracket."""
    print(f"Fixing punk-record.json...")

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # The file has valid JSON up to position 1133721 (the closing bracket)
    # After that, there's extra data: ","timestamp":1772562915195,"isStreaming":false,"costUsd":0.56074475,"durationMs":226620,"inputTokens":55,"outputTokens":35
    # We need to truncate at the last valid closing bracket

    # Find the last closing bracket
    last_bracket = content.rfind("]")
    if last_bracket == -1:
        print("  ✗ No closing bracket found")
        return False

    # Truncate at the closing bracket
    fixed_content = content[: last_bracket + 1]

    # Verify the truncated content
    try:
        data = json.loads(fixed_content)
        print(f"  ✓ Valid JSON after truncation at position {last_bracket}")

        # Write back
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(f"  ✓ Successfully fixed punk-record.json")
        return True
    except json.JSONDecodeError as e:
        print(f"  ✗ Still invalid after truncation: {e}")
        return False


def fix_pulse(filepath):
    """Fix pulse.json which has invalid control characters."""
    print(f"Fixing pulse.json...")

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # The error is at position 2001534: "Invalid control character at"
    # We need to find and remove/replace invalid control characters

    # First, let's try to find the problematic area
    error_pos = 2001534
    start = max(0, error_pos - 100)
    end = min(len(content), error_pos + 100)
    context = content[start:end]

    print(f"  Error context: {repr(context)}")

    # Remove control characters (except for common ones like \n, \t, \r)
    # We'll replace other control characters with space
    cleaned = []
    for i, char in enumerate(content):
        if i >= error_pos - 10 and i <= error_pos + 10:
            # In the error region, be more aggressive
            if ord(char) < 32 and char not in "\n\r\t":
                cleaned.append(" ")
                print(f"  Replaced control character at position {i}: {repr(char)}")
            else:
                cleaned.append(char)
        else:
            # Outside error region, be conservative
            if char.isprintable() or char in "\n\r\t":
                cleaned.append(char)
            else:
                cleaned.append(" ")

    fixed_content = "".join(cleaned)

    # Try to parse
    try:
        data = json.loads(fixed_content)
        print(f"  ✓ Valid JSON after cleaning control characters")

        # Write back
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(f"  ✓ Successfully fixed pulse.json")
        return True
    except json.JSONDecodeError as e:
        print(f"  ✗ Still invalid after cleaning: {e}")

        # Try alternative approach: truncate to last valid JSON
        last_brace = fixed_content.rfind("}")
        last_bracket = fixed_content.rfind("]")
        last_close = max(last_brace, last_bracket)

        if last_close != -1:
            try:
                data = json.loads(fixed_content[: last_close + 1])
                print(f"  ✓ Valid after truncating at position {last_close}")

                with open(filepath, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)

                print(f"  ✓ Successfully fixed by truncation")
                return True
            except json.JSONDecodeError as e2:
                print(f"  ✗ Truncation also failed: {e2}")

        return False


def fix_aslam_portfolio(filepath):
    """Fix aslam-portfolio.json which has delimiter errors."""
    print(f"Fixing aslam-portfolio.json...")

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # The error is at position 2521778: "Expecting ',' delimiter"
    # This usually means there's a missing comma between array elements or object properties

    error_pos = 2521778
    start = max(0, error_pos - 100)
    end = min(len(content), error_pos + 100)
    context = content[start:end]

    print(f"  Error context: {repr(context)}")

    # Look at what's around the error position
    if error_pos < len(content):
        print(f"  Character at error position: {repr(content[error_pos])}")
        print(
            f"  Characters before: {repr(content[max(0, error_pos - 10) : error_pos])}"
        )
        print(
            f"  Characters after: {repr(content[error_pos : min(len(content), error_pos + 10)])}"
        )

    # Try to find the structure around the error
    # Look for patterns like: "value1" "value2" or } { or ] [

    # First, try to insert a comma at the error position
    fixed_content = content[:error_pos] + "," + content[error_pos:]

    try:
        data = json.loads(fixed_content)
        print(f"  ✓ Valid JSON after inserting comma at position {error_pos}")

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(f"  ✓ Successfully fixed by inserting comma")
        return True
    except json.JSONDecodeError as e:
        print(f"  ✗ Inserting comma didn't work: {e}")

    # Try truncating to last valid JSON
    last_brace = content.rfind("}")
    last_bracket = content.rfind("]")
    last_close = max(last_brace, last_bracket)

    if last_close != -1:
        try:
            data = json.loads(content[: last_close + 1])
            print(f"  ✓ Valid after truncating at position {last_close}")

            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)

            print(f"  ✓ Successfully fixed by truncation")
            return True
        except json.JSONDecodeError as e2:
            print(f"  ✗ Truncation also failed: {e2}")

    return False


def main():
    """Main function to manually fix the corrupted files."""
    home_dir = Path.home()
    conversations_dir = home_dir / ".pane" / "conversations"

    if not conversations_dir.exists():
        print(f"Conversations directory not found: {conversations_dir}")
        return

    # Files to fix
    files_to_fix = [
        ("punk-record.json", fix_punk_record),
        ("pulse.json", fix_pulse),
        ("aslam-portfolio.json", fix_aslam_portfolio),
    ]

    print("Manual fix for corrupted Pane conversation files")
    print("=" * 60)

    for filename, fix_func in files_to_fix:
        filepath = conversations_dir / filename

        if not filepath.exists():
            print(f"File not found: {filepath}")
            continue

        print(f"\nProcessing {filename}...")

        # Create backup
        backup_path = filepath.with_suffix(filepath.suffix + ".manual.bak")
        try:
            shutil.copy2(filepath, backup_path)
            print(f"  Created backup: {backup_path}")
        except Exception as e:
            print(f"  ✗ Error creating backup: {e}")
            continue

        # Try to fix
        if fix_func(filepath):
            print(f"  ✓ Successfully fixed {filename}")
        else:
            print(f"  ✗ Failed to fix {filename}")
            # Restore from backup
            try:
                shutil.copy2(backup_path, filepath)
                print(f"  Restored original from backup")
            except Exception as e:
                print(f"  ✗ Error restoring from backup: {e}")

    print("\n" + "=" * 60)
    print("Manual fix complete.")
    print("Note: Original files have been backed up with .manual.bak extension")


if __name__ == "__main__":
    main()
