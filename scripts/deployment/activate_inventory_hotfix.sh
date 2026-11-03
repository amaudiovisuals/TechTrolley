#!/usr/bin/env bash
# This release path deliberately refuses schema, configuration and dependency changes.
set -euo pipefail
umask 077
candidate=${1:?Exact tested commit required}
[[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || exit 2
cd "$HOME/TechTrolley"
previous=$(git rev-parse HEAD)
test "$(git rev-parse "$candidate^{commit}")" = "$candidate"
dirty=$(git diff --name-only HEAD -- . ':(exclude)**/__pycache__/**')
test -z "$dirty" || { echo 'Source changes on server require review before deployment.'; exit 1; }
git diff --quiet "$previous" "$candidate" -- backend/config backend/core/models.py backend/core/migrations backend/requirements.txt package.json package-lock.json || {
  echo 'This code-only release path refuses schema, settings or dependency changes.'; exit 1;
}
test -d dist/assets
test "$(cat dist/build-revision.txt)" = "$candidate"
public=/var/www/html/techtrolley
test -f "$public/index.html"
backup="$HOME/deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-${previous:0:12}"
mkdir -p "$backup"
git archive --format=tar.gz "$previous" > "$backup/source.tar.gz"
tar -C "$public" -czf "$backup/frontend.tar.gz" .
sudo -n -u postgres pg_dump --format=custom --no-owner --no-acl techtrolley_prod > "$backup/database.dump"
sudo -n -u postgres pg_restore --list < "$backup/database.dump" > "$backup/database-contents.list"
tar -C backend -czf "$backup/media.tar.gz" media
printf '%s\n' "$previous" > "$backup/previous-revision"
printf '%s\n' "$candidate" > "$backup/candidate-revision"
activated=0
rollback() {
  code=$?
  trap - ERR
  set +e
  if test "$activated" = 1; then
    git reset --hard "$previous"
    sudo tar -xzf "$backup/frontend.tar.gz" -C "$public"
    sudo systemctl restart gunicorn
  fi
  echo "Release failed. Prior source/frontend restored where possible. Checkpoint: $backup"
  echo 'The business database was not restored or reversed.'
  exit "$code"
}
trap rollback ERR
umask 022
activated=1
git reset --hard "$candidate"
export DJANGO_ENV=production PYTHONDONTWRITEBYTECODE=1
backend/venv/bin/python -B backend/manage.py check
backend/venv/bin/python -B backend/manage.py migrate --check
sudo systemctl restart gunicorn
health=https://techtrolley.amaudiovisuals.com
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --resolve techtrolley.amaudiovisuals.com:443:127.0.0.1 "$health/api/company-settings/" > /dev/null
# Preserve old chunks for existing browser tabs. Switch the entry point last.
sudo mkdir -p "$public/assets"
sudo cp -r dist/assets/. "$public/assets/"
for file in dist/*; do
  if test -f "$file" && test "${file##*/}" != index.html && test "${file##*/}" != sw.js; then
    sudo install -m 644 "$file" "$public/${file##*/}"
  fi
done
sudo install -m 644 dist/index.html "$public/index.html.next"
sudo mv "$public/index.html.next" "$public/index.html"
sudo install -m 644 dist/sw.js "$public/sw.js.next"
sudo mv "$public/sw.js.next" "$public/sw.js"
deployed=$(curl --fail --silent --show-error --resolve techtrolley.amaudiovisuals.com:443:127.0.0.1 "$health/build-revision.txt")
test "$deployed" = "$candidate"
printf '%s\n' "$candidate" > "$backup/activated-revision"
trap - ERR
echo "Code-only release active: $candidate. Private checkpoint: $backup"
