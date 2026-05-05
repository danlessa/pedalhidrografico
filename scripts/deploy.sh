#!/usr/bin/env bash
#
# Sync the static site at public/ to gs://telhas/rota_app.
#
# Usage:
#   scripts/deploy.sh             # sync (uploads new + changed, deletes orphans)
#   scripts/deploy.sh --dry-run   # preview what would change, make no edits
#
# Requirements:
#   - gcloud CLI installed (https://cloud.google.com/sdk/docs/install)
#   - authenticated: `gcloud auth login`  (or service account)
#   - permissions to write to gs://telhas/rota_app
#
# Behavior notes:
#   - Uses the modern `gcloud storage rsync`, which is faster than the old
#     `gsutil rsync` and supports parallel multi-part uploads natively.
#   - --delete-unmatched-destination-objects removes remote files that no
#     longer exist locally, so removed files actually disappear from the site.
#   - After sync, the PWA-critical "shell" files get `Cache-Control: no-cache,
#     must-revalidate` so service-worker / HTML updates reach users without
#     waiting for cached copies to expire.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="$REPO_ROOT/public"
BUCKET_DIR="gs://telhas/rota_app"

# ─── Argument parsing ────────────────────────────────────────────────────────
DRY=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=(--dry-run)
  echo "↻ DRY RUN — no remote changes will be made."
fi

# ─── Pre-flight ──────────────────────────────────────────────────────────────
if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi
if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "ERROR: $LOCAL_DIR does not exist" >&2
  exit 1
fi

# Build routes.json if it's missing. Without it, /rotas data on the deployed
# site will be empty, and that's almost never what you want.
if [[ ! -f "$LOCAL_DIR/routes.json" ]]; then
  echo "→ routes.json missing locally — running 'npm run build:routes' first…"
  (cd "$REPO_ROOT" && npm run build:routes)
fi

# ─── Sync ────────────────────────────────────────────────────────────────────
echo "→ Syncing $LOCAL_DIR  →  $BUCKET_DIR"
# ${DRY[@]+"${DRY[@]}"} expands to nothing if the array is empty/unset —
# avoids the "unbound variable" error from `set -u` on bash 3.2 (macOS).
# --exclude is a regex; this skips macOS .DS_Store files at any depth and
# also any text editor swap files that might be lying around.
gcloud storage rsync \
  --recursive \
  --delete-unmatched-destination-objects \
  --exclude='(^|.*/)(\.DS_Store|Thumbs\.db|.*\.swp|.*\.swo|\.git/.*)$' \
  ${DRY[@]+"${DRY[@]}"} \
  "$LOCAL_DIR" "$BUCKET_DIR"

# ─── Cache-Control for the PWA shell ─────────────────────────────────────────
# These files must always revalidate, otherwise the service worker traps users
# on the old version and updates never propagate.
if [[ "${#DRY[@]}" -eq 0 ]]; then
  # Files that change on most deploys and that the SW also fetches via
  # stale-while-revalidate — force browsers/CDN to revalidate every time so
  # the network copy actually races the cached one.
  echo "→ Setting Cache-Control: no-cache on shell + main script/style"
  for f in index.html sw.js manifest.json routes.json app.js style.css; do
    if gcloud storage objects describe "$BUCKET_DIR/$f" --quiet >/dev/null 2>&1; then
      gcloud storage objects update "$BUCKET_DIR/$f" \
        --cache-control="no-cache, must-revalidate" --quiet
      echo "   ✓ $f"
    else
      echo "   · $f not present (skipped)"
    fi
  done

  # Cache-busting: rewrite index.html so app.js / style.css carry a query
  # string unique to this deploy. CDN sees a brand-new URL, caches a brand-
  # new entry, and the user's browser fetches the fresh content instead of
  # whatever stale copy was sitting at the edge.
  DEPLOY_VERSION=$(date +%s)
  TMP_INDEX="$(mktemp)"
  trap 'rm -f "$TMP_INDEX"' EXIT
  sed \
    -e "s|src=\"app.js\"|src=\"app.js?v=$DEPLOY_VERSION\"|g" \
    -e "s|href=\"style.css\"|href=\"style.css?v=$DEPLOY_VERSION\"|g" \
    "$LOCAL_DIR/index.html" > "$TMP_INDEX"
  # Force text/html — gcloud auto-detects from the source extension, but our
  # temp file has none and would otherwise upload as application/octet-stream
  # (which makes browsers download instead of render the page).
  gcloud storage cp "$TMP_INDEX" "$BUCKET_DIR/index.html" \
    --content-type="text/html" \
    --cache-control="no-cache, must-revalidate" --quiet
  echo "→ Cache-busted index.html with ?v=$DEPLOY_VERSION (app.js, style.css)"

  # Hard-invalidate Cloud CDN edge caches for /rota_app/*. Override via env
  # vars if your project layout differs (or set CLOUD_CDN_URL_MAP="" to skip).
  CDN_URL_MAP="${CLOUD_CDN_URL_MAP-tiles-map}"
  CDN_PROJECT="${CLOUD_CDN_PROJECT-pedal-hidrografico}"
  CDN_PATH="${CLOUD_CDN_INVALIDATE_PATH-/rota_app/*}"
  if [[ -n "$CDN_URL_MAP" ]]; then
    echo "→ Invalidating Cloud CDN: $CDN_URL_MAP path=$CDN_PATH"
    gcloud compute url-maps invalidate-cdn-cache "$CDN_URL_MAP" \
      --project="$CDN_PROJECT" \
      --path "$CDN_PATH" --async
  fi
fi

echo "✓ Done."
echo "  Bucket path:    $BUCKET_DIR"
echo "  Public URL:     https://telhas.pedalhidrografi.co/rota_app/index.html"
echo "  (Or whatever your CDN / load balancer maps to that prefix.)"
