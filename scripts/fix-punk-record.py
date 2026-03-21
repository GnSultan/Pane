#!/usr/bin/env python3
"""
Fix punk-record.json by adding missing closing brace.
The file is missing the closing brace for the root object.
"""

import json
import shutil
from pathlib import Path


def fix_punk_record():
    """Fix the punk-record.json file."""
    filepath = Path.home() / ".pane" / "conversations" / "punk-record.json"

    if not filepath.exists():
        print(f"File not found: {filepath}")
        return False

    # Create backup
    backup_path = filepath.with_suffix(filepath.suffix + ".backup")
    shutil.copy2(filepath, backup_path)
    print(f"Created backup at: {backup_path}")

    # Read the file
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    print(f"File length: {len(content)} characters")

    # Check the structure
    # The file should be: {"sessionId":..., "model":..., "messages": [...]}
    # But it's missing the closing brace

    # Count braces and brackets
    open_braces = content.count("{")
    close_braces = content.count("}")
    open_brackets = content.count("[")
    close_brackets = content.count("]")

    print(f"Open braces: {open_braces}, Close braces: {close_braces}")
    print(f"Open brackets: {open_brackets}, Close brackets: {close_brackets}")
    print(f"Missing closing braces: {open_braces - close_braces}")
    print(f"Missing closing brackets: {open_brackets - close_brackets}")

    # The file is missing 26 closing braces and 2 closing brackets
    # But we need to be careful - we should only add what's needed

    # Let's look at the structure
    # The file ends with: ..."outputTokens":35
    # We need to add: }]

    # First, let's try to add just the missing closing characters
    # Based on the structure, we need:
    # - Close the last message object with }
    # - Close the messages array with ]
    # - Close the root object with }

    # But the file already has some closing characters
    # Let's look at what's at the end

    last_100 = content[-100:]
    print(f"\nLast 100 characters: {repr(last_100)}")

    # The file ends with: ..."outputTokens":35
    # This looks like the last message is missing its closing brace

    # Let's try to add the missing closing characters
    # Based on the structure, we need to add: }]

    # But wait, the extra data after the messages array is:
    # ],"timestamp":1772562915195,"isStreaming":false,"costUsd":0.56074475,"durationMs":226620,"inputTokens":55,"outputTokens":35

    # This looks like it should be part of the last message
    # Let's check if the last message is missing some fields

    # The extra data starts with: ]
    # This closes the messages array
    # Then there's: ,"timestamp":...
    # This looks like it should be part of the last message

    # Let's try a different approach
    # Let's look at the structure more carefully

    # Find the messages array
    messages_start = content.find("[")
    messages_end = content.rfind("]")

    print(f"\nMessages array: positions {messages_start} to {messages_end}")

    # The messages array ends at position 1133721
    # After that, we have extra data

    # Let's check what's after the messages array
    after_messages = content[messages_end:]
    print(f"\nAfter messages array: {repr(after_messages)}")

    # The extra data is:
    # ],"timestamp":1772562915195,"isStreaming":false,"costUsd":0.56074475,"durationMs":226620,"inputTokens":55,"outputTokens":35

    # This looks like it should be part of the last message
    # But it starts with ] which closes the messages array

    # Let's check if the last message is incomplete
    # The last message should have all these fields:
    # id, type, content, timestamp, isStreaming, costUsd, durationMs, inputTokens, outputTokens

    # Let's look at the last message
    last_message_start = content.rfind("{", messages_start)
    last_message_end = messages_end

    print(f"\nLast message: positions {last_message_start} to {last_message_end}")

    # Get the last message
    last_message = content[last_message_start:last_message_end]
    print(f"\nLast message: {repr(last_message[:200])}")

    # The last message seems to end with: "outputTokens":35}
    # But the extra data has: ,"timestamp":1772562915195,"isStreaming":false,...

    # This suggests the last message is missing some fields
    # Let's check what fields are in the last message

    # The last message should have:
    # id, type, content, timestamp, isStreaming, costUsd, durationMs, inputTokens, outputTokens

    # But the last message seems to end with just "outputTokens":35}
    # Let's check if the extra data can be added to the last message

    # The extra data is:
    # ],"timestamp":1772562915195,"isStreaming":false,"costUsd":0.56074475,"durationMs":226620,"inputTokens":55,"outputTokens":35

    # If we remove the leading ], we get:
    # ,"timestamp":1772562915195,"isStreaming":false,"costUsd":0.56074475,"durationMs":226620,"inputTokens":55,"outputTokens":35

    # This looks like it should be part of the last message
    # But it starts with a comma, which suggests it's continuing the last message

    # Let's try to reconstruct the file
    # The structure should be:
    # {
    #   "sessionId": "...",
    #   "model": "...",
    #   "messages": [...]
    # }

    # But the file has extra data after the messages array
    # Let's try to add the missing closing brace

    # The extra data is:
    # ],"timestamp":1772562915195,"isStreaming":false,"costUsd":0.56074475,"durationMs":226620,"inputTokens":55,"outputTokens":35

    # This looks like it should be part of the last message
    # But it starts with ] which closes the messages array

    # Let's try a different approach
    # Let's look at the structure of the last message

    # The last message should have:
    # {
    #   "id": "...",
    #   "type": "...",
    #   "content": [...],
    #   "timestamp": ...,
    #   "isStreaming": false,
    #   "costUsd": ...,
    #   "durationMs": ...,
    #   "inputTokens": ...,
    #   "outputTokens": ...
    # }

    # But the last message seems to be missing some fields
    # Let's check what fields are in the last message

    # Let's look at the last message more carefully
    # The last message starts with: {project}/manifest.json` and surfaces...
    # This looks like it's missing the id and type fields

    # Let's check if the last message is actually a continuation of the previous message
    # Or if it's a new message that's missing some fields

    # Let's look at the structure of the messages array
    # Find all message objects

    # This is complex, let's try a different approach
    # Let's try to parse the messages array up to the last message

    # Let's look at the structure around the last message
    context_start = max(0, last_message_start - 200)
    context_end = min(len(content), last_message_start + 200)
    context = content[context_start:context_end]
    print(f"\nContext around last message: {repr(context)}")

    # The last message seems to be missing the opening brace
    # Let's check what's at position 1133339

    # The character at position 1133339 is: {
    # So the last message does start with {

    # But the last message seems to be missing some fields
    # Let's check what fields are in the last message

    # Let's try to add the missing closing brace
    # The file should end with: }]

    # But the file already has some closing characters
    # Let's check what's at the end

    # The file ends with: ..."outputTokens":35
    # We need to add: }]

    # Let's try to add the missing closing brace
    fixed_content = content + "}]"

    # Try to parse
    try:
        data = json.loads(fixed_content)
        print(f"\n✓ Successfully parsed after adding '}}]'")
        print(f"Session ID: {data.get('sessionId')}")
        print(f"Model: {data.get('model')}")
        print(f"Number of messages: {len(data.get('messages', []))}")

        # Write the fixed file
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(f"\n✓ Fixed file saved")

        # Verify
        with open(filepath, "r", encoding="utf-8") as f:
            json.load(f)
        print(f"✓ Verification passed")
        return True
    except json.JSONDecodeError as e:
        print(f"\n✗ Still invalid: {e}")
        print(f"Error position: {e.pos}")

        # Show context around error
        if e.pos < len(fixed_content):
            start = max(0, e.pos - 50)
            end = min(len(fixed_content), e.pos + 50)
            context = fixed_content[start:end]
            print(f"Context: {repr(context)}")

        return False


if __name__ == "__main__":
    fix_punk_record()
