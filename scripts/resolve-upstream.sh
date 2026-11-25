#!/usr/bin/env bash
set -euo pipefail

mode="${RESOLVE_MODE:-discover}"
case "$mode" in
  discover|verify-candidate) ;;
  *) echo "Unknown upstream resolution mode: $mode" >&2; exit 1 ;;
esac

state="$RUNNER_TEMP/upstream-state.json"
# Always verify the current signed stable index. The tracked state is only a
# publication receipt; it must never supply an unverified build candidate.
git clone --depth=1 https://github.com/ilysenko/codex-desktop-linux.git "$RUNNER_TEMP/upstream"
node "$RUNNER_TEMP/upstream/scripts/lib/upstream-linux-package.js" \
  --output-dir "$RUNNER_TEMP/metadata" \
  --metadata "$RUNNER_TEMP/package.json" \
  --key-base64 "$RUNNER_TEMP/upstream/assets/openai-codex-linux-repository-key.gpg.base64" \
  --arch amd64 --metadata-only
jq -S --arg sha "$(git -C "$RUNNER_TEMP/upstream" rev-parse HEAD)" \
  '{wrapper_sha:$sha, official_version:.version, official_path:.repositoryPath, official_sha256:.sha256}' \
  "$RUNNER_TEMP/package.json" > "$state"
jq -e '
  (.wrapper_sha | test("^[0-9a-f]{40}$")) and
  (.official_sha256 | test("^[0-9a-f]{64}$")) and
  (.official_version | test("^[0-9][0-9A-Za-z.+:~-]*$")) and
  (.official_path | test("^pool/[A-Za-z0-9._+/-]+\\.deb$")) and
  (.official_path | split("/") | all(. != ".."))
' "$state" > /dev/null

if [ "$mode" = verify-candidate ]; then
  jq -e '
    (.base_sha | test("^[0-9a-f]{40}$")) and
    (.source_tree | test("^[0-9a-f]{64}$")) and
    (.generation | type == "string" and length > 0)
  ' upstream-candidate.json > /dev/null
  # An upstream update between preparation and validation must produce a new
  # candidate commit, never silently change the inputs of this commit.
  if ! diff -u \
    <(jq -S '{wrapper_sha, official_version, official_path, official_sha256}' upstream-candidate.json) \
    "$state"; then
    echo 'Upstream changed after staging was prepared; a new staging candidate is required.' >&2
    exit 1
  fi
fi

jq -r 'to_entries[] | "\(.key)=\(.value)"' "$state" >> "$GITHUB_OUTPUT"
