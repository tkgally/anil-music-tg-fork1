#!/usr/bin/env bash
# Mirror studio-prototypes/ into docs/ (GitHub Pages serves docs/).
#
# docs/ is a 1:1 copy of studio-prototypes/ plus a .nojekyll marker; the hub
# index.html is shared (written to serve both the Pages audience and someone
# who downloaded the folder). Run this after ANY change to the prototypes:
#
#   bash studio-prototypes/tools/sync-docs.sh
#
# and commit the docs/ changes together with the prototype change.
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root

rm -rf docs
mkdir -p docs
cp -r studio-prototypes/. docs/
rm -f docs/.gitignore               # in-flight-build ignores don't apply to the mirror
touch docs/.nojekyll                # serve files as-is; no Jekyll pass

echo "docs/ now mirrors studio-prototypes/:"
diff -rq studio-prototypes docs --exclude=.nojekyll --exclude=.gitignore \
  && echo "  (no differences)"
