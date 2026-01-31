#!/usr/bin/env bash
set -euo pipefail

# Deploy n8n-nodes-engram to local n8n instance
# Usage:
#   ./scripts/deploy-local.sh          # rebuild and reinstall (no version bump)
#   ./scripts/deploy-local.sh patch    # bump patch version, then deploy
#   ./scripts/deploy-local.sh minor    # bump minor version, then deploy

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG_NAME="n8n-nodes-engram"
N8N_NODES_DIR="$HOME/.n8n/nodes"
N8N_CACHE_DIR="$HOME/.cache/n8n/public/types"
N8N_DB="$HOME/.n8n/database.sqlite"

cd "$PROJECT_DIR"

# --- Version bump (optional) ---
BUMP_TYPE="${1:-}"
if [[ -n "$BUMP_TYPE" ]]; then
    echo "==> Bumping $BUMP_TYPE version..."
    npm version "$BUMP_TYPE" --no-git-tag-version
fi

VERSION=$(node -p "require('./package.json').version")
AUTHOR_NAME=$(node -p "require('./package.json').author?.name || 'casistack'")
AUTHOR_EMAIL=$(node -p "require('./package.json').author?.email || 'contact@casistack.com'")
TGZ_FILE="${PKG_NAME}-${VERSION}.tgz"

echo "==> Deploying $PKG_NAME v$VERSION"

# --- Clean & Build ---
echo "==> Cleaning dist/..."
rm -rf dist

echo "==> Building..."
npm run build

# --- Pack ---
echo "==> Packing..."
rm -f "$PKG_NAME"-*.tgz
npm pack --quiet

if [[ ! -f "$TGZ_FILE" ]]; then
    echo "ERROR: Expected $TGZ_FILE not found"
    exit 1
fi

# --- Ensure n8n nodes directory exists ---
if [[ ! -d "$N8N_NODES_DIR" ]]; then
    echo "==> Creating $N8N_NODES_DIR..."
    mkdir -p "$N8N_NODES_DIR"
    (cd "$N8N_NODES_DIR" && npm init -y --quiet)
fi

# --- Uninstall old version ---
echo "==> Uninstalling old version from n8n..."
(cd "$N8N_NODES_DIR" && npm uninstall "$PKG_NAME" 2>/dev/null) || true

# --- Install new version ---
echo "==> Installing $TGZ_FILE into n8n..."
(cd "$N8N_NODES_DIR" && npm install "$PROJECT_DIR/$TGZ_FILE" --quiet)

# --- Register in n8n database (Community Nodes) ---
if [[ -f "$N8N_DB" ]]; then
    echo "==> Registering in n8n Community Nodes database..."
    NOW=$(date -u '+%Y-%m-%d %H:%M:%S.000')

    # Upsert installed_packages
    sqlite3 "$N8N_DB" "
        INSERT OR REPLACE INTO installed_packages (packageName, installedVersion, authorName, authorEmail, createdAt, updatedAt)
        VALUES ('$PKG_NAME', '$VERSION', '$AUTHOR_NAME', '$AUTHOR_EMAIL', '$NOW', '$NOW');
    "
    echo "    Package: $PKG_NAME v$VERSION"

    # Clear old node entries for this package
    sqlite3 "$N8N_DB" "DELETE FROM installed_nodes WHERE package = '$PKG_NAME';"

    # Read node names from package.json and extract display names from compiled JS
    node -e "
        const pkg = require('$N8N_NODES_DIR/node_modules/$PKG_NAME/package.json');
        const fs = require('fs');
        const path = require('path');
        const nodes = pkg.n8n?.nodes || [];
        nodes.forEach(nodePath => {
            const fullPath = path.join('$N8N_NODES_DIR/node_modules/$PKG_NAME', nodePath);
            const content = fs.readFileSync(fullPath, 'utf8');
            // Extract displayName and name from the compiled JS
            const displayMatch = content.match(/displayName:\s*['\"]([^'\"]+)['\"]/);
            const nameMatch = content.match(/(?:^|\\n)\\s*name:\s*['\"]([a-zA-Z]+)['\"]/m);
            const versionMatch = content.match(/version:\s*\[([^\]]+)\]/);
            const displayName = displayMatch ? displayMatch[1] : path.basename(nodePath, '.node.js');
            const nodeName = nameMatch ? nameMatch[1] : '';
            const latestVersion = versionMatch ? versionMatch[1].split(',').pop().trim() : 1;
            if (nodeName) {
                console.log(JSON.stringify({
                    displayName,
                    type: '$PKG_NAME.' + nodeName,
                    version: parseInt(latestVersion) || 1
                }));
            }
        });
    " | while IFS= read -r line; do
        DISPLAY_NAME=$(echo "$line" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).displayName")
        NODE_TYPE=$(echo "$line" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).type")
        NODE_VER=$(echo "$line" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
        sqlite3 "$N8N_DB" "
            INSERT OR REPLACE INTO installed_nodes (name, type, latestVersion, package)
            VALUES ('$DISPLAY_NAME', '$NODE_TYPE', $NODE_VER, '$PKG_NAME');
        "
        echo "    Node: $DISPLAY_NAME ($NODE_TYPE) v$NODE_VER"
    done
else
    echo "    WARN: n8n database not found at $N8N_DB, skipping registration"
fi

# --- Clear n8n cache ---
echo "==> Clearing n8n node type cache..."
rm -f "$N8N_CACHE_DIR/nodes.json" "$N8N_CACHE_DIR/credentials.json" 2>/dev/null || true

# --- Verify ---
INSTALLED_VERSION=$(node -p "require('$N8N_NODES_DIR/node_modules/$PKG_NAME/package.json').version" 2>/dev/null || echo "NOT FOUND")
NODE_COUNT=$(sqlite3 "$N8N_DB" "SELECT COUNT(*) FROM installed_nodes WHERE package = '$PKG_NAME';" 2>/dev/null || echo "?")
echo ""
echo "============================================"
echo "  Deployed $PKG_NAME v$INSTALLED_VERSION"
echo "  Community Nodes: $NODE_COUNT nodes registered"
echo "============================================"
echo ""
echo "  Restart n8n and hard-refresh browser (Ctrl+Shift+R)"
echo ""

# --- Cleanup .tgz ---
rm -f "$PROJECT_DIR/$PKG_NAME"-*.tgz
