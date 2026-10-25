#!/bin/sh
# /app/data is a volume: uploads, placed nodes and fingerprints written by the
# bridge survive a redeploy. Files from the repo are copied in on first start
# and never overwrite what is already there.
set -eu
mkdir -p /app/data/cache /app/data/uploads
for f in /app/data-seed/*; do
  [ -e "/app/data/$(basename "$f")" ] || cp -r "$f" /app/data/
done
# Live nodes only by default. BRIDGE_ARGS adds flags, e.g. "--mock --mock-people"
# for the simulated crowd. Unquoted on purpose so it splits into flags.
exec /app/bridge --data /app/data --static /app/public --http :8080 --tcp :9000 ${BRIDGE_ARGS-} "$@"
