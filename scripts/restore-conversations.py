#!/usr/bin/env python3
"""
Restore conversations from recovered data.
This script takes the extracted message objects and reconstructs
proper conversation files that Pane can load.
"""

import json
import os
import shutil
import sys
from pathlib import Path


def restore_conversation(recovery_file, output_file):
    """Restore a conversation from recovered data."""
    print(f"\nRestoring conversation from {recovery_file.name}...")

    try:
        # Load the recovered data
        with open(recovery_file, "r", encoding="utf-8") as f:
            recovery_data = json.load(f)

        # Check if it has the expected structure
        if "messages" not in recovery_data:
            print(f"  ✗ Recovery file doesn't contain messages")
            return False

        messages = recovery_data["messages"]
        print(f"  Found {len(messages)} messages")

        # Create a proper conversation structure
        # Use a generic session ID since we don't have the original
        conversation_data = {
            "sessionId": f"recovered-{recovery_file.stem}",
            "model": "claude-opus-4-6",  # Default model
            "messages": messages,
            "timestamp": recovery_data.get("timestamp", 1772670759125),
            "isStreaming": False,
            "costUsd": recovery_data.get("costUsd", 0),
            "durationMs": recovery_data.get("durationMs", 0),
            "inputTokens": recovery_data.get("inputTokens", 0),
            "outputTokens": recovery_data.get("outputTokens", 0),
            "numTurns": len(messages)
        }

        # Save the restored conversation
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(conversation_data, f, indent=2)

        print(f"  ✓ Restored conversation with {len(messages)} messages")
        return True

    except Exception as e:
        print(f"  ✗ Error restoring conversation: {e}")
        return False


def main():
    """Main function."""
    home_dir = Path.home()
    conversations_dir = home_dir / ".pane" / "conversations"
    recovery_dir = conversations_dir / "recovery"

    if not recovery_dir.exists():
        print(f"Recovery directory not found: {recovery_dir}")
        print("Run extract-messages.py first to create recovery files.")
        return

    # Find all recovered files
    recovered_files = list(recovery_dir.glob("*.recovered.json"))

    if not recovered_files:
        print("No recovery files found.")
        return

    print("Restore conversations from recovered data")
    print("=" * 60)
    print(f"Found {len(recovered_files)} recovery files")

    restored_count = 0
    failed_count = 0

    for recovery_file in recovered_files:
        # Determine output filename
        output_filename = recovery_file.stem  # Remove .recovered.json
        output_file = conversations_dir / f"{output_filename}.json"

        # Create backup of existing file if it exists
        if output_file.exists():
            backup_file = output_file.with_suffix(".json.before-restore")
            try:
                shutil.copy2(output_file, backup_file)
                print(f"  Created backup: {backup_file}")
            except Exception as e:
                print(f"  ✗ Error creating backup: {e}")
                continue

        if restore_conversation(recovery_file, output_file):
            restored_count += 1
        else:
            failed_count += 1

    print("\n" + "=" * 60)
    print(f"Summary:")
    print(f"  Restored: {restored_count}")
    print(f"  Failed: {failed_count}")
    print(f"  Total: {len(recovered_files)}")

    if restored_count > 0:
        print(f"\nRestored conversations are now available in: {conversations_dir}")
        print("You may need to restart Pane to see the restored conversations.")


if __name__ == "__main__":
    main()