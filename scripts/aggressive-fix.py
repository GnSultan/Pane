import argparse
import json
import os
import re
import sys
from pathlib import Path


def extract_valid_json(text):
    """
    Try to extract a valid JSON structure from corrupted text.
    This function attempts to fix common JSON corruption issues:
    1. Unterminated strings
    2. Missing commas between objects/properties
    3. Extra characters at the end
    4. Missing closing brackets/braces
    """
    # Remove any leading/trailing whitespace
    text = text.strip()

    # Try to parse directly first
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError as e:
        print(f"JSON decode error: {e}")
        pass

    # Strategy 1: Try to find the longest valid JSON prefix
    # This handles cases where there's extra garbage at the end
    for i in range(len(text), 0, -1):
        try:
            json.loads(text[:i])
            # If we get here, text[:i] is valid JSON
            print(f"Found valid JSON prefix of length {i}")
            return text[:i]
        except json.JSONDecodeError:
            continue

    # Strategy 2: Try to fix common issues with regex patterns
    repaired = text

    # Fix unterminated strings by adding quotes at the end of the string
    # Look for strings that start with a quote but don't end with one before a comma, bracket, or brace
    string_pattern = r'("[^"\\]*(?:\\.[^"\\]*)*)(?=[,\]}])'

    def fix_unterminated_string(match):
        return match.group(1) + '"'

    repaired = re.sub(string_pattern, fix_unterminated_string, repaired)

    # Fix missing commas between array elements or object properties
    # Look for patterns like: ...}"{ or ...]"{ or ...}"[ or ...]"[ etc.
    missing_comma_pattern = r'(?<=[}\]])"'
    repaired = re.sub(missing_comma_pattern, ',"', repaired)

    missing_comma_pattern2 = r"(?<=[}\]]){"
    repaired = re.sub(missing_comma_pattern2, ",{", repaired)

    missing_comma_pattern3 = r"(?<=[}\]])\["
    repaired = re.sub(missing_comma_pattern3, ",[", repaired)

    # Fix missing closing brackets/braces by counting
    open_braces = repaired.count("{")
    close_braces = repaired.count("}")
    open_brackets = repaired.count("[")
    close_brackets = repaired.count("]")

    if open_braces > close_braces:
        repaired += "}" * (open_braces - close_braces)
    if open_brackets > close_brackets:
        repaired += "]" * (open_brackets - close_brackets)

    # Try parsing again
    try:
        json.loads(repaired)
        return repaired
    except json.JSONDecodeError as e:
        print(f"Still invalid JSON after repair: {e}")

    # Strategy 3: Extract JSON objects/arrays using more aggressive heuristics
    # Look for the outermost JSON structure
    # Find the first '{' or '[' and try to extract from there
    first_brace = repaired.find("{")
    first_bracket = repaired.find("[")

    start_pos = -1
    if first_brace >= 0 and (first_bracket < 0 or first_brace < first_bracket):
        start_pos = first_brace
    elif first_bracket >= 0:
        start_pos = first_bracket

    if start_pos >= 0:
        # Try to extract from start_pos to end
        for end_pos in range(len(repaired), start_pos, -1):
            try:
                json.loads(repaired[start_pos:end_pos])
                print(f"Extracted JSON from position {start_pos} to {end_pos}")
                return repaired[start_pos:end_pos]
            except json.JSONDecodeError:
                continue

    # Last resort: return empty object
    print("Warning: Could not extract valid JSON, returning empty object")
    return "{}"


def fix_json_file(file_path, backup=True):
    """Fix a corrupted JSON file."""
    file_path = Path(file_path)

    if not file_path.exists():
        print(f"Error: File {file_path} does not exist")
        return False

    # Read the file
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"Error reading file: {e}")
        return False

    # Create backup if requested
    if backup:
        backup_path = file_path.with_suffix(file_path.suffix + ".backup")
        try:
            with open(backup_path, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"Created backup at {backup_path}")
        except Exception as e:
            print(f"Warning: Could not create backup: {e}")

    # Try to extract valid JSON
    print(f"Attempting to repair {file_path}...")
    repaired_content = extract_valid_json(content)

    # Write the repaired content
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(repaired_content)
        print(f"Successfully repaired {file_path}")

        # Verify the repaired JSON
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                json.load(f)
            print("Repaired JSON validates successfully")
            return True
        except json.JSONDecodeError as e:
            print(f"Warning: Repaired JSON still has issues: {e}")
            return False
    except Exception as e:
        print(f"Error writing repaired file: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Aggressively fix corrupted JSON files"
    )
    parser.add_argument("files", nargs="+", help="JSON files to fix")
    parser.add_argument(
        "--no-backup", action="store_true", help="Do not create backup files"
    )
    parser.add_argument(
        "--recursive", "-r", action="store_true", help="Recursively process directories"
    )

    args = parser.parse_args()

    files_to_process = []

    for file_pattern in args.files:
        path = Path(file_pattern)

        if args.recursive and path.is_dir():
            for root, dirs, files in os.walk(path):
                for file in files:
                    if file.endswith(".json"):
                        files_to_process.append(Path(root) / file)
        elif path.is_file():
            files_to_process.append(path)
        else:
            # Try glob pattern
            import glob

            for file in glob.glob(file_pattern):
                files_to_process.append(Path(file))

    if not files_to_process:
        print("No files found to process")
        return

    print(f"Found {len(files_to_process)} file(s) to process")

    success_count = 0
    for file_path in files_to_process:
        print(f"\nProcessing {file_path}...")
        if fix_json_file(file_path, backup=not args.no_backup):
            success_count += 1

    print(
        f"\nDone! Successfully repaired {success_count}/{len(files_to_process)} file(s)"
    )


if __name__ == "__main__":
    main()
