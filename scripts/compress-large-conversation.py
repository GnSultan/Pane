#!/usr/bin/env python3
"""
Compress large conversation files to fit within Tauri's 5MB file read limit.
This script helps when conversations grow too large and need to be trimmed
or compressed to be loadable by the Pane application.
"""

import json
import os
import shutil
import sys
from pathlib import Path


def compress_conversation(filepath, max_size_mb=5):
    """
    Compress a conversation file by removing older messages or trimming content.
    
    Strategy:
    1. Remove messages older than a certain threshold
    2. Truncate large content fields while keeping message structure
    3. Remove duplicate thinking blocks
    """
    max_bytes = max_size_mb * 1024 * 1024
    
    print(f"\nCompressing {filepath.name}...")
    print(f"  Target max size: {max_size_mb}MB ({max_bytes:,} bytes)")
    
    # Read the file
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"  ✗ Error parsing JSON: {e}")
        return False
    except Exception as e:
        print(f"  ✗ Error reading file: {e}")
        return False
    
    original_size = filepath.stat().st_size
    print(f"  Original size: {original_size:,} bytes ({original_size/1024/1024:.2f}MB)")
    
    if original_size <= max_bytes:
        print(f"  ✓ File is already under {max_size_mb}MB")
        return True
    
    # Check if we have a messages array
    if "messages" not in data:
        print(f"  ✗ No 'messages' field found in conversation")
        return False
    
    messages = data["messages"]
    print(f"  Messages: {len(messages)}")
    
    # Strategy 1: Remove messages older than a threshold (keep recent ones)
    # Keep only the most recent 50 messages or last 24 hours
    print(f"  Strategy: Keep recent messages only...")
    
    # If messages have timestamps, sort and keep recent ones
    if all("timestamp" in msg for msg in messages[-10:]):  # Check last 10 messages
        messages.sort(key=lambda x: x.get("timestamp", 0))
        
        # Keep last 100 messages (or all if less than 100)
        keep_count = min(100, len(messages))
        kept_messages = messages[-keep_count:]
        removed_count = len(messages) - keep_count
        print(f"    Removed {removed_count} older messages")
        print(f"    Kept {len(kept_messages)} messages")
        data["messages"] = kept_messages
    else:
        print(f"    Warning: Messages don't have timestamps, keeping all")
    
    # Strategy 2: Truncate large content fields
    print(f"  Strategy: Truncating large content fields...")
    
    def truncate_content(message, max_chars=5000):
        """Truncate large content fields in a message."""
        if "content" not in message:
            return message
        
        content = message["content"]
        
        # Handle content as list of content blocks
        if isinstance(content, list):
            new_content = []
            for item in content:
                if isinstance(item, dict) and "text" in item:
                    # Truncate text fields
                    text = item["text"]
                    if len(text) > max_chars:
                        # Keep beginning and end, but truncate middle
                        keep_from_start = max_chars // 2
                        keep_from_end = max_chars - keep_from_start
                        truncated = text[:keep_from_start] + "\n\n... [truncated] ...\n\n" + text[-keep_from_end:]
                        item["text"] = truncated
                        print(f"    Truncated content field from {len(text)} to {len(truncated)} chars")
                    new_content.append(item)
                elif isinstance(item, str):
                    # Truncate string content
                    if len(item) > max_chars:
                        truncated = item[:max_chars] + "\n\n... [truncated] ...\n"
                        print(f"    Truncated string content from {len(item)} to {len(truncated)} chars")
                        new_content.append(truncated)
                    else:
                        new_content.append(item)
                else:
                    new_content.append(item)
            message["content"] = new_content
        elif isinstance(content, str):
            # Handle string content
            if len(content) > max_chars:
                truncated = content[:max_chars] + "\n\n... [truncated] ...\n"
                print(f"    Truncated message content from {len(content)} to {len(truncated)} chars")
                message["content"] = truncated
        
        return message
    
    for msg in data["messages"]:
        truncate_content(msg)
    
    # Strategy 3: Remove duplicate thinking blocks (if any)
    print(f"  Strategy: Removing duplicate thinking blocks...")
    
    def is_duplicate_thinking(block1, block2):
        """Check if two thinking blocks are duplicates."""
        if block1.get("type") != "thinking" or block2.get("type") != "thinking":
            return False
        return block1.get("thinking", "") == block2.get("thinking", "")
    
    for msg in data["messages"]:
        if "content" in msg and isinstance(msg["content"], list):
            content = msg["content"]
            new_content = []
            seen_thinking = set()
            
            for item in content:
                if item.get("type") == "thinking":
                    thinking_text = item.get("thinking", "")
                    if thinking_text not in seen_thinking:
                        seen_thinking.add(thinking_text)
                        new_content.append(item)
                    else:
                        print(f"    Removed duplicate thinking block")
                else:
                    new_content.append(item)
            
            msg["content"] = new_content
    
    # Calculate new size
    try:
        new_content_str = json.dumps(data, separators=(',', ':'))
        new_size = len(new_content_str)
    except Exception as e:
        print(f"  ✗ Error calculating new size: {e}")
        return False
    
    compression_ratio = new_size / original_size
    print(f"  New size: {new_size:,} bytes ({new_size/1024/1024:.2f}MB)")
    print(f"  Compression: {compression_ratio:.1%} of original")
    
    if new_size > max_bytes:
        print(f"  ⚠ Still too large ({new_size} > {max_bytes})")
        print(f"     Consider removing more messages or enabling strict truncation")
        return False
    
    # Create backup
    backup_path = filepath.with_suffix(filepath.suffix + f".pre-compress-{int(original_size/1024)}k")
    try:
        shutil.copy2(filepath, backup_path)
        print(f"  Backup created: {backup_path.name}")
    except Exception as e:
        print(f"  ✗ Error creating backup: {e}")
        return False
    
    # Save compressed file
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"  ✓ Saved compressed file")
        print(f"    Space saved: {original_size - new_size:,} bytes")
        return True
    except Exception as e:
        print(f"  ✗ Error saving file: {e}")
        # Try to restore backup
        try:
            shutil.copy2(backup_path, filepath)
            print(f"  Restored from backup")
        except:
            print(f"  Warning: Could not restore backup")
        return False


def compress_all_conversations(conversations_dir, max_size_mb=5):
    """Compress all conversation files that are too large."""
    print(f"Checking conversation files in {conversations_dir}...")
    
    max_bytes = max_size_mb * 1024 * 1024
    
    # Find files larger than the limit
    large_files = []
    for filepath in conversations_dir.glob("*.json"):
        if filepath.stat().st_size > max_bytes:
            large_files.append(filepath)
    
    if not large_files:
        print(f"✓ No files larger than {max_size_mb}MB found")
        return True
    
    print(f"\nFound {len(large_files)} files larger than {max_size_mb}MB:")
    for filepath in large_files:
        size_mb = filepath.stat().st_size / 1024 / 1024
        print(f"  - {filepath.name}: {size_mb:.2f}MB")
    
    print(f"\nPress Enter to compress these files, or Ctrl+C to cancel...")
    try:
        input()
    except KeyboardInterrupt:
        print("\nCancelled")
        return False
    
    success_count = 0
    for filepath in large_files:
        if compress_conversation(filepath, max_size_mb):
            success_count += 1
    
    print(f"\n{'='*60}")
    print(f"Compression complete: {success_count}/{len(large_files)} successful")
    return success_count == len(large_files)


def main():
    """Main function."""
    home_dir = Path.home()
    conversations_dir = home_dir / ".pane" / "conversations"
    
    if not conversations_dir.exists():
        print(f"Conversations directory not found: {conversations_dir}")
        print(f"Make sure Pane has been run at least once to create this directory.")
        sys.exit(1)
    
    # Check for specific file or compress all
    if len(sys.argv) > 1:
        # Compress specific file
        filepath = conversations_dir / sys.argv[1]
        if not filepath.exists():
            print(f"File not found: {filepath}")
            sys.exit(1)
        
        success = compress_conversation(filepath)
        sys.exit(0 if success else 1)
    else:
        # Compress all large files
        success = compress_all_conversations(conversations_dir)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
