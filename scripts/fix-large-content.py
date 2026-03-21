#!/usr/bin/env python3
"""
Fix for corrupted Pane conversation files with large content fields.
Handles content with unescaped newlines and special characters.
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path


def fix_large_content_file(filepath):
    """Fix a conversation file with large content fields."""
    print(f"\nProcessing {filepath.name}...")

    # Create backup
    backup_path = filepath.with_suffix(filepath.suffix + ".large.bak")
    try:
        shutil.copy2(filepath, backup_path)
        print(f"  Created backup: {backup_path}")
    except Exception as e:
        print(f"  ✗ Error creating backup: {e}")
        return False

    # Read the file as raw bytes to preserve exact content
    try:
        with open(filepath, "rb") as f:
            raw_content = f.read()
    except Exception as e:
        print(f"  ✗ Error reading file: {e}")
        return False

    print(f"  Original size: {len(raw_content):,} bytes")

    # Convert to string, replacing invalid UTF-8 sequences
    content = raw_content.decode('utf-8', errors='replace')
    print(f"  Decoded size: {len(content):,} bytes")

    # Step 1: Find and fix content fields with unescaped newlines
    # Pattern to match content fields that have unescaped newlines
    # This is a complex pattern that tries to match JSON content fields

    def fix_content_field(match):
        """Fix a content field that has unescaped characters."""
        full_match = match.group(0)
        content_text = match.group(1)

        # Check if content has unescaped newlines
        if '\n' in content_text and '\\n' not in content_text:
            # This content field needs escaping
            # Escape the content properly for JSON
            escaped_content = json.dumps(content_text)[1:-1]  # Remove outer quotes
            return f'"content":"{escaped_content}"'

        return full_match

    # Pattern to match content fields (simplified)
    # This matches: "content":"..." where ... may contain newlines
    content_pattern = r'"content":"((?:[^"\\]|\\.)*)"'

    # Apply the fix
    fixed_content = re.sub(content_pattern, fix_content_field, content, flags=re.DOTALL)

    print(f"  Fixed content fields")

    # Step 2: Try to parse the JSON
    try:
        data = json.loads(fixed_content)
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

        # Try alternative approach: manually construct the JSON
        try:
            # Look for the structure: {"messages": [...], "timestamp": ...}
            # and try to extract it

            # Find the last valid closing bracket
            last_bracket = fixed_content.rfind(']')
            if last_bracket >= 0:
                # Try to parse everything up to and including the bracket
                test_content = fixed_content[:last_bracket + 1]

                # Try to find the start of the messages array
                messages_start = test_content.rfind('"messages":[')
                if messages_start >= 0:
                    # Find the corresponding opening bracket
                    bracket_count = 0
                    for i in range(messages_start, len(test_content)):
                        if test_content[i] == '[':
                            bracket_count += 1
                        elif test_content[i] == ']':
                            bracket_count -= 1
                            if bracket_count == 0:
                                # Found the end of the messages array
                                end_of_messages = i

                                # Extract the structure before and after messages
                                before_messages = test_content[:messages_start]
                                after_messages = test_content[end_of_messages + 1:]

                                # Try to construct a valid JSON structure
                                # Look for timestamp, isStreaming, etc.
                                timestamp_match = re.search(r'"timestamp":\s*(\d+)', after_messages)
                                is_streaming_match = re.search(r'"isStreaming":\s*(\w+)', after_messages)
                                cost_match = re.search(r'"costUsd":\s*([\d.]+)', after_messages)
                                duration_match = re.search(r'"durationMs":\s*(\d+)', after_messages)
                                input_tokens_match = re.search(r'"inputTokens":\s*(\d+)', after_messages)
                                output_tokens_match = re.search(r'"outputTokens":\s*(\d+)', after_messages)
                                num_turns_match = re.search(r'"numTurns":\s*(\d+)', after_messages)

                                # Construct a minimal valid JSON structure
                                reconstructed = '{'
                                reconstructed += f'"messages":{test_content[messages_start:end_of_messages + 1]}'

                                if timestamp_match:
                                    reconstructed += ',"timestamp":' + timestamp_match.group(1)
                                if is_streaming_match:
                                    reconstructed += ',"isStreaming":' + is_streaming_match.group(1).lower()
                                if cost_match:
                                    reconstructed += ',"costUsd":' + cost_match.group(1)
                                if duration_match:
                                    reconstructed += ',"durationMs":' + duration_match.group(1)
                                if input_tokens_match:
                                    reconstructed += ',"inputTokens":' + input_tokens_match.group(1)
                                if output_tokens_match:
                                    reconstructed += ',"outputTokens":' + output_tokens_match.group(1)
                                if num_turns_match:
                                    reconstructed += ',"numTurns":' + num_turns_match.group(1)

                                reconstructed += '}'

                                # Try to parse the reconstructed JSON
                                try:
                                    data = json.loads(reconstructed)
                                    print(f"  ✓ Reconstructed valid JSON structure")

                                    with open(filepath, "w", encoding="utf-8") as f:
                                        json.dump(data, f, indent=2)

                                    print(f"  ✓ Successfully fixed {filepath.name}")
                                    print(f"    - Messages: {len(data.get('messages', []))}")
                                    print(f"    - Timestamp: {data.get('timestamp', 'N/A')}")
                                    return True
                                except Exception as e3:
                                    print(f"  ✗ Reconstructed JSON also invalid: {e3}")

        except Exception as e2:
            print(f"  ✗ Could not reconstruct JSON: {e2}")

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

    print("Fix for corrupted Pane conversation files with large content")
    print("=" * 60)

    fixed_count = 0
    failed_count = 0

    for filename in files_to_fix:
        filepath = conversations_dir / filename

        if not filepath.exists():
            print(f"\nFile not found: {filepath}")
            continue

        if fix_large_content_file(filepath):
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
        print("Backup files have been created with .large.bak extension.")


if __name__ == "__main__":
    main()