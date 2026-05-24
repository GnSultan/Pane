#!/bin/bash
# Pane Cloud — one-time setup + deploy script
# Run this once to provision everything, then `npm run deploy` for updates.

set -e

echo "==> Pane Cloud Setup"
echo ""

# 1. Create D1 database
echo "[1/4] Creating D1 database..."
DB_OUTPUT=$(wrangler d1 create pane-cloud 2>&1)
echo "$DB_OUTPUT"

# Extract database_id from output
DB_ID=$(echo "$DB_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

if [ -z "$DB_ID" ]; then
  echo "ERROR: Could not extract database_id. Check wrangler output above."
  exit 1
fi

echo "  database_id: $DB_ID"

# Patch wrangler.toml with the real database_id
sed -i.bak "s/database_id = \"\"/database_id = \"$DB_ID\"/" wrangler.toml
rm -f wrangler.toml.bak
echo "  Updated wrangler.toml"

# 2. Create R2 bucket
echo ""
echo "[2/4] Creating R2 bucket..."
wrangler r2 bucket create pane-backups

# 3. Apply schema to D1
echo ""
echo "[3/4] Applying database schema..."
wrangler d1 execute pane-cloud --remote --file=./schema.sql

# 4. Set secrets
echo ""
echo "[4/4] Setting secrets..."
echo ""
echo "You need two things from your GitHub OAuth App:"
echo "  https://github.com/settings/developers → OAuth Apps → New OAuth App"
echo "  Homepage URL: https://pane-cloud.workers.dev"
echo "  Callback URL: pane://auth/callback"
echo ""
read -p "  GitHub Client ID: " GITHUB_CLIENT_ID
read -p "  GitHub Client Secret: " GITHUB_CLIENT_SECRET

echo "$GITHUB_CLIENT_SECRET" | wrangler secret put GITHUB_CLIENT_SECRET

# Also set client ID as a var (it's not secret, but convenient to set here)
# Update wrangler.toml vars section
sed -i.bak "s/GITHUB_CLIENT_ID = \"\"/GITHUB_CLIENT_ID = \"$GITHUB_CLIENT_ID\"/" wrangler.toml
rm -f wrangler.toml.bak

echo ""
echo "  Client ID saved to wrangler.toml"
echo "  Client Secret saved as Wrangler secret"

# 5. Deploy
echo ""
echo "==> Deploying Worker..."
wrangler deploy

echo ""
echo "Done! Your Pane Cloud Worker is live."
echo ""
echo "Next step: set github_client_id in pane-app/src/main/cloud-auth.mjs:"
echo "  const DEFAULT_GITHUB_CLIENT_ID = \"$GITHUB_CLIENT_ID\";"
echo ""
