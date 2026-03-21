#!/usr/bin/env python3
"""
Extract message content from corrupted conversation files.
This script tries to recover as much conversation data as possible
by extracting individual message objects from the corrupted JSON.
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path


def extract_message_objects(content):
    """
    Extract individual message objects from corrupted JSON content.
    Returns a list of message objects that can be parsed.
    """
    messages = []

    # Pattern to match message objects (simplified)
    # Looking for: {"id": "...", "type": "...", "content": [...], "timestamp": ...}
    # This is a simplified pattern that might miss some edge cases

    # Try to find message blocks
    message_pattern = r'\{[^}]*"id":\s*"[^"]*"[^}]*"type":\s*"[^"]*"[^}]*"content":\s*\[[^]]*\][^}]*"timestamp":\s*\d+[^}]*\}'

    matches = re.finditer(message_pattern, content, re.DOTALL)

    for match in matches:
        try:
            message_obj = json.loads(match.group(0))
            messages.append(message_obj)
        except json.JSONDecodeError:
            # Try to fix the message object
            fixed_message = fix_message_object(match.group(0))
            if fixed_message:
                messages.append(fixed_message)

    return messages


def fix_message_object(message_str):
    """Try to fix a single message object."""
    try:
        # Try to parse as-is
        return json.loads(message_str)
    except json.JSONDecodeError:
        pass

    # Try to fix common issues
    # 1. Remove null bytes
    message_str = message_str.replace('\x00', '')

    # 2. Escape unescaped quotes in content
    # Look for content field patterns and escape quotes
    content_pattern = r'"content":\s*\[(.*?)\]'
    content_match = re.search(content_pattern, message_str, re.DOTALL)

    if content_match:
        content_text = content_match.group(1)
        # Escape quotes in the content text
        escaped_content = content_text.replace('"', '\\"')
        message_str = message_str[:content_match.start(1)] + escaped_content + message_str[content_match.end(1):]

    try:
        return json.loads(message_str)
    except json.JSONDecodeError:
        return None


def recover_conversation(filepath, output_dir):
    """Try to recover conversation from a corrupted file."""
    print(f"\nRecovering conversation from {filepath.name}...")

    # Read the file
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except Exception as e:
        print(f"  ✗ Error reading file: {e}")
        return False

    print(f"  File size: {len(content):,} bytes")

    # Extract message objects
    messages = extract_message_objects(content)
    print(f"  Extracted {len(messages)} message objects")

    if messages:
        # Create a recovery structure
        recovery_data = {
            "recovered": True,
            "source_file": str(filepath),
            "messages": messages,
            "timestamp": 1772670759125,  # Use a recent timestamp
            "isStreaming": False,
            "costUsd": 0,
            "durationMs": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "numTurns": len(messages)
        }

        # Save the recovery
        output_file = output_dir / f"{filepath.stem}.recovered.json"
        try:
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(recovery_data, f, indent=2)
            print(f"  ✓ Saved recovery to {output_file}")
            print(f"    - Messages: {len(messages)}")
            return True
        except Exception as e:
            print(f"  ✗ Error saving recovery: {e}")
            return False
    else:
        print(f"  ✗ Could not extract any message objects")
        return False


def main():
    """Main function."""
    home_dir = Path.home()
    conversations_dir = home_dir / ".pane" / "conversations"

    if not conversations_dir.exists():
        print(f"Conversations directory not found: {conversations_dir}")
        return

    # Create recovery directory
    recovery_dir = conversations_dir / "recovery"
    recovery_dir.mkdir(exist_ok=True)

    # Files to recover
    files_to_recover = [
        "punk-record.json",
        "pulse.json",
        "aslam-portfolio.json"
    ]

    print("Recover conversations from corrupted files")
    print("=" * 60)
    print(f"Recovery directory: {recovery_dir}")

    recovered_count = 0
    failed_count = 0

    for filename in files_to_recover:
        filepath = conversations_dir / filename

        if not filepath.exists():
            print(f"\nFile not found: {filepath}")
            continue

        if recover_conversation(filepath, recovery_dir):
            recovered_count += 1
        else:
            failed_count += 1

    print("\n" + "=" * 60)
    print(f"Summary:")
    print(f"  Recovered: {recovered_count}")
    print(f"  Failed: {failed_count}")
    print(f"  Total: {len(files_to_recover)}")

    if recovered_count > 0:
        print(f"\nRecovery files saved to: {recovery_dir}")
        print("You can manually inspect these files and extract any needed conversation data.")


if __name__ == "__main__":
    main()