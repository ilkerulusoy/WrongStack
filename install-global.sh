#!/usr/bin/env bash
# Derle ve wrongstack'i global olarak (repo'dan bağımsız kopya) kur.
set -e
cd /Users/ilkerulusoy/git/git_harness/WrongStack
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"

CI=true corepack pnpm -r --workspace-concurrency=2 build
npm rm -g wrongstack 2>/dev/null || true
rm -rf /tmp/wrongstack-dist
corepack pnpm --filter wrongstack --legacy deploy --prod /tmp/wrongstack-dist
npm install -g /tmp/wrongstack-dist

echo "✓ Kuruldu. Çalıştır: wstack  (veya wrongstack)"
