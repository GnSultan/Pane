#!/usr/bin/env python3
"""
Script to fix corrupted JSON conversation files by adding missing closing braces and brackets.
This script attempts to repair JSON files that have been truncated or corrupted during save.
"""

import json
import os
import re
import sys
from pathlib import Path


def fix_json_string(json_str):
    """
    Attempt to fix common JSON corruption issues:
    1. Missing closing braces/brackets
    2. Unterminated strings
    3. Trailing commas
    4. Extra characters after JSON
    """
    if not json_str.strip():
        return json_str

    original = json_str
    fixed = json_str.strip()

    # Try to parse first - if it works, return as-is
    try:
        json.loads(fixed)
        return fixed
    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")

    # Fix 1: Add missing closing braces/brackets
    # Count opening vs closing braces and brackets
    open_braces = fixed.count("{")
    close_braces = fixed.count("}")
    open_brackets = fixed.count("[")
    close_brackets = fixed.count("]")

    # Add missing closing braces
    if open_braces > close_braces:
        missing_braces = open_braces - close_braces
        fixed += "}" * missing_braces
        print(f"Added {missing_braces} missing closing brace(s)")

    # Add missing closing brackets
    if open_brackets > close_brackets:
        missing_brackets = open_brackets - close_brackets
        fixed += "]" * missing_brackets
        print(f"Added {missing_brackets} missing closing bracket(s)")

    # Fix 2: Handle unterminated strings
    # Check if we have an odd number of quotes (unterminated string)
    # But be careful - we might have escaped quotes
    # Simple approach: if ends with quote but no closing quote, add one
    if fixed.endswith('"'):
        # Check if the last quote is escaped
        if not fixed.endswith('\\"'):
            # Count quotes from the end
            quote_count = 0
            i = len(fixed) - 1
            while i >= 0 and fixed[i] == '"':
                # Check if this quote is escaped
                j = i - 1
                escape_count = 0
                while j >= 0 and fixed[j] == "\\":
                    escape_count += 1
                    j -= 1

                # If even number of backslashes, quote is not escaped
                if escape_count % 2 == 0:
                    quote_count += 1
                i -= 1

            # If odd number of unescaped quotes at the end, we need to close
            if quote_count % 2 == 1:
                fixed += '"'
                print("Added missing closing quote")

    # Fix 3: Remove trailing commas before closing braces/brackets
    # This regex finds commas that are followed by whitespace and then } or ]
    fixed = re.sub(r",\s*([}\]])", r"\1", fixed)

    # Fix 4: Remove extra characters after JSON
    # Find the last complete JSON structure
    # Look for the last closing brace or bracket
    last_brace = fixed.rfind("}")
    last_bracket = fixed.rfind("]")
    last_close = max(last_brace, last_bracket)

    if last_close != -1:
        # Try to parse up to that point
        test_str = fixed[: last_close + 1]
        try:
            json.loads(test_str)
            # If successful, truncate at this point
            fixed = test_str
            print(f"Truncated extra characters after position {last_close}")
        except json.JSONDecodeError:
            pass

    # Fix 5: Handle missing commas between array elements or object properties
    # This is more complex, so we'll try a simple approach
    # Look for patterns like: "value1" "value2" or } { or ] [
    fixed = re.sub(r'("[^"]*")\s+("[^"]*")', r"\1,\2", fixed)
    fixed = re.sub(r'([}\]"])\s+([{\["])', r"\1,\2", fixed)

    # Try parsing again
    try:
        json.loads(fixed)
        print("Successfully fixed JSON")
        return fixed
    except json.JSONDecodeError as e:
        print(f"Could not fully fix JSON: {e}")
        # Return the best attempt
        return fixed


def fix_json_file(filepath):
    """Fix a single JSON file"""
    filepath = Path(filepath)
    if not filepath.exists():
        print(f"File not found: {filepath}")
        return False

    # Create backup
    backup_path = filepath.with_suffix(filepath.suffix + ".bak")
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        # Create backup
        with open(backup_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Created backup at: {backup_path}")

        # Try to fix
        fixed_content = fix_json_string(content)

        # Write fixed content
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(fixed_content)

        # Verify the fix
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                json.load(f)
            print(f"Successfully fixed: {filepath}")
            return True
        except json.JSONDecodeError as e:
            print(f"Still corrupted after fix: {filepath} - {e}")
            # Restore from backup
            with open(backup_path, "r", encoding="utf-8") as f:
                original_content = f.read()
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(original_content)
            print(f"Restored original from backup")
            return False

    except Exception as e:
        print(f"Error processing {filepath}: {e}")
        return False


def find_conversation_files(directory):
    """Find conversation JSON files in a directory"""
    directory = Path(directory)
    conversation_files = []

    # Look for files that might be conversation files
    for filepath in directory.rglob("*"):
        if filepath.is_file():
            # Check if it's a JSON file
            if filepath.suffix.lower() in [".json", ".jsonl"]:
                # Check if filename suggests it's a conversation file
                filename_lower = filepath.name.lower()
                if any(
                    keyword in filename_lower
                    for keyword in ["conversation", "chat", "messages", "history"]
                ):
                    conversation_files.append(filepath)
                else:
                    # Try to read first few chars to see if it's JSON
                    try:
                        with open(filepath, "r", encoding="utf-8") as f:
                            first_chars = f.read(100)
                            if first_chars.strip().startswith(
                                "["
                            ) or first_chars.strip().startswith("{"):
                                conversation_files.append(filepath)
                    except:
                        pass

    return conversation_files


def main():
    if len(sys.argv) < 2:
        print("Usage: python fix-corrupted.py <file_or_directory>")
        print("Example: python fix-corrupted.py /path/to/conversation.json")
        print("Example: python fix-corrupted.py /path/to/project")
        sys.exit(1)

    target = sys.argv[1]

    if os.path.isfile(target):
        # Fix single file
        success = fix_json_file(target)
        sys.exit(0 if success else 1)
    elif os.path.isdir(target):
        # Find and fix all conversation files in directory
        files = find_conversation_files(target)
        print(f"Found {len(files)} potential conversation files")

        success_count = 0
        for filepath in files:
            print(f"\nProcessing: {filepath}")
            if fix_json_file(filepath):
                success_count += 1

        print(f"\nFixed {success_count} out of {len(files)} files")
        sys.exit(0 if success_count > 0 else 1)
    else:
        print(f"Target not found: {target}")
        sys.exit(1)


if __name__ == "__main__":
    main()
