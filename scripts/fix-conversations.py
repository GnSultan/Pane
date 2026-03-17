import json
import os
import shutil
import sys
from pathlib import Path


def fix_json_file(file_path):
    """Attempt to fix a corrupted JSON file by reading and rewriting it."""
    print(f"Attempting to fix: {file_path}")

    # Create backup
    backup_path = file_path + ".bak"
    shutil.copy2(file_path, backup_path)
    print(f"Created backup at: {backup_path}")

    try:
        # Read the entire file
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Try to parse the JSON
        data = json.loads(content)

        # If successful, write it back with proper formatting
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(f"✓ Successfully fixed: {file_path}")
        return True

    except json.JSONDecodeError as e:
        print(f"✗ JSON decode error: {e}")

        # Try to fix common JSON issues
        try:
            # Attempt to fix by reading line by line and removing invalid characters
            fixed_lines = []
            with open(file_path, "r", encoding="utf-8") as f:
                for line_num, line in enumerate(f, 1):
                    # Remove any non-printable characters that might break JSON
                    line = "".join(
                        char for char in line if char.isprintable() or char in "\n\r\t"
                    )
                    fixed_lines.append(line)

            fixed_content = "".join(fixed_lines)

            # Try parsing the fixed content
            data = json.loads(fixed_content)

            # Write fixed JSON back
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)

            print(f"✓ Fixed using character filtering: {file_path}")
            return True

        except Exception as e2:
            print(f"✗ Could not fix: {e2}")

            # Try one more approach - read as JSON5 if available
            try:
                import json5

                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read()
                data = json5.loads(content)
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
                print(f"✓ Fixed using JSON5: {file_path}")
                return True
            except ImportError:
                print("JSON5 not available. Install with: pip install json5")
            except Exception as e3:
                print(f"✗ JSON5 also failed: {e3}")

    return False


def find_conversation_files(base_dir):
    """Find conversation.json files in the given directory and its subdirectories."""
    conversation_files = []

    for root, dirs, files in os.walk(base_dir):
        for file in files:
            if file == "conversation.json":
                full_path = os.path.join(root, file)
                conversation_files.append(full_path)

    return conversation_files


def main():
    # Get the user's home directory
    home_dir = str(Path.home())

    # Projects mentioned in the error logs
    projects = ["punk-record", "pulse", "aslam-portfolio", "pane", "narrative-engine"]

    # Also check the Pane directory itself
    pane_dir = os.path.join(home_dir, "Pane")

    all_files = []

    # Look for conversation.json files in each project directory
    for project in projects:
        project_dir = os.path.join(home_dir, project)
        if os.path.exists(project_dir):
            files = find_conversation_files(project_dir)
            all_files.extend(files)
            print(f"Found {len(files)} conversation files in {project_dir}")

    # Look in the Pane directory itself
    if os.path.exists(pane_dir):
        files = find_conversation_files(pane_dir)
        all_files.extend(files)
        print(f"Found {len(files)} conversation files in {pane_dir}")

    if not all_files:
        print("No conversation.json files found.")
        return

    print(f"\nFound {len(all_files)} conversation files total.")
    print("Attempting to fix corrupted JSON files...\n")

    fixed_count = 0
    failed_count = 0

    for file_path in all_files:
        print("-" * 60)
        if fix_json_file(file_path):
            fixed_count += 1
        else:
            failed_count += 1
        print()

    print("=" * 60)
    print(f"Summary:")
    print(f"  Fixed: {fixed_count}")
    print(f"  Failed: {failed_count}")
    print(f"  Total: {len(all_files)}")

    if failed_count > 0:
        print("\nSome files could not be fixed automatically.")
        print("You may need to manually inspect these files or restore from backup.")
        print("Backup files have been created with the .bak extension.")


if __name__ == "__main__":
    main()
