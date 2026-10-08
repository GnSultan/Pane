#!/bin/bash
#
# migrate-keychain-to-file.sh
#
# One-time migration: extracts Claude OAuth credentials from macOS Keychain
# to file-based storage, then removes the keychain entries.
#
# This eliminates the constant macOS password prompts caused by keychain ACL
# (Access Control List) issues — both Pane and Claude CLI trigger these prompts
# because their keychain entries don't have stable ACL trust entries for the
# calling process.
#
# After migration:
#   - Pane reads from ~/.pane/claude-credentials.json (mode 0600)
#   - Claude CLI reads from ~/.claude/.credentials.json (mode 0600)
#   - No keychain access needed → no password prompts
#
# Usage: bash scripts/migrate-keychain-to-file.sh
#

set -euo pipefail

USERNAME="$(whoami)"
PANE_DIR="$HOME/.pane"
CLAUDE_DIR="$HOME/.claude"
PANE_FILE="$PANE_DIR/claude-credentials.json"
CLAUDE_FILE="$CLAUDE_DIR/.credentials.json"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Keychain → File Credential Migration                        ║"
echo "║  Eliminates macOS password prompts for Claude/Pane access    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo

# ── Pane credentials ─────────────────────────────────────────────────────

echo "── Pane credentials ──"
PANE_KC_RAW=""
# Try both possible account names for Pane keychain entries
for acct in "pane-claude-oauth" "$USERNAME"; do
  PANE_KC_RAW="$(/usr/bin/security find-generic-password -s "Pane Claude-credentials" -a "$acct" -w 2>/dev/null || true)"
  if [ -n "$PANE_KC_RAW" ]; then
    echo "  Found Pane keychain entry (account: $acct)"
    break
  fi
done

if [ -n "$PANE_KC_RAW" ]; then
  mkdir -p "$PANE_DIR"
  chmod 700 "$PANE_DIR"
  echo "$PANE_KC_RAW" > "$PANE_FILE"
  chmod 600 "$PANE_FILE"
  echo "  ✅ Written to $PANE_FILE (mode 0600)"

  # Remove keychain entry
  for acct in "pane-claude-oauth" "$USERNAME"; do
    /usr/bin/security delete-generic-password -s "Pane Claude-credentials" -a "$acct" 2>/dev/null || true
  done
  echo "  🗑️  Removed Pane keychain entry"
else
  if [ -f "$PANE_FILE" ]; then
    echo "  ⏭️  No keychain entry found, but file already exists at $PANE_FILE"
  else
    echo "  ⚠️  No Pane credentials found in keychain. Run login from Pane app first."
  fi
fi
echo

# ── Claude Code credentials ──────────────────────────────────────────────

echo "── Claude Code credentials ──"
CLAUDE_KC_RAW="$(/usr/bin/security find-generic-password -s "Claude Code-credentials" -a "$USERNAME" -w 2>/dev/null || true)"

if [ -n "$CLAUDE_KC_RAW" ]; then
  echo "  Found Claude Code keychain entry"

  # Claude Code expects the claudeAiOauth wrapper structure
  # Check if the keychain value already has it or if it's raw
  if echo "$CLAUDE_KC_RAW" | python3 -c "import sys, json; d=json.load(sys.stdin); assert 'claudeAiOauth' in d or 'accessToken' in d" 2>/dev/null; then
    # Already has the right structure
    PAYLOAD="$CLAUDE_KC_RAW"
  else
    # Wrap it in claudeAiOauth structure
    PAYLOAD="$(echo "$CLAUDE_KC_RAW" | python3 -c "
import sys, json
raw = json.load(sys.stdin)
if 'claudeAiOauth' in raw:
    print(json.dumps(raw))
else:
    print(json.dumps({'claudeAiOauth': raw}))
" 2>/dev/null || echo "$CLAUDE_KC_RAW")"
  fi

  mkdir -p "$CLAUDE_DIR"
  echo "$PAYLOAD" > "$CLAUDE_FILE"
  chmod 600 "$CLAUDE_FILE"
  echo "  ✅ Written to $CLAUDE_FILE (mode 0600)"

  # Remove keychain entry
  /usr/bin/security delete-generic-password -s "Claude Code-credentials" -a "$USERNAME" 2>/dev/null || true
  echo "  🗑️  Removed Claude Code keychain entry"
else
  if [ -f "$CLAUDE_FILE" ]; then
    echo "  ⏭️  No keychain entry found, but file already exists at $CLAUDE_FILE"
  else
    echo "  ⚠️  No Claude Code credentials found in keychain."
    echo "     Run 'claude login' first, then re-run this script."
  fi
fi
echo

# ── Verify ───────────────────────────────────────────────────────────────

echo "── Verification ──"
if [ -f "$PANE_FILE" ]; then
  echo "  ✅ $PANE_FILE exists ($(stat -f%z "$PANE_FILE") bytes)"
else
  echo "  ❌ $PANE_FILE missing"
fi
if [ -f "$CLAUDE_FILE" ]; then
  echo "  ✅ $CLAUDE_FILE exists ($(stat -f%z "$CLAUDE_FILE") bytes)"
else
  echo "  ❌ $CLAUDE_FILE missing"
fi
echo

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Migration complete.                                         ║"
echo "║                                                              ║"
echo "║  • Pane and Claude CLI will now read credentials from file   ║"
echo "║  • No more macOS keychain password prompts                   ║"
echo "║  • Restart Pane and any Claude CLI sessions to pick up       ║"
echo "║    the file-based credentials                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
