#!/usr/bin/env bash
# Bounded additive-table release. Later code-only releases use the existing path.
set -euo pipefail
umask 077
candidate=${1:?Exact tested commit required}
[[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || exit 2
cd "$HOME/TechTrolley"
previous=$(git rev-parse HEAD)
schema_base=78c50a333d1a483be9c26f0d75934116bca3f3d4
if test "$previous" != "$schema_base"; then
  git show "$candidate:scripts/deployment/activate_inventory_hotfix.sh" | bash -s -- "$candidate"
  exit 0
fi
test "$(git rev-parse "$candidate^{commit}")" = "$candidate"
dirty=$(git diff --name-only HEAD -- . ':(exclude)**/__pycache__/**')
test -z "$dirty" || { echo 'Server source changes require review.'; exit 1; }
git diff --quiet "$previous" "$candidate" -- backend/config backend/requirements.txt package.json package-lock.json
git show "$candidate:scripts/deployment/check_delivery_schema_change.py" | backend/venv/bin/python -B - "$previous" "$candidate"
test -d dist/assets
test "$(cat dist/build-revision.txt)" = "$candidate"
public=/var/www/html/techtrolley
test -f "$public/index.html"
backup="$HOME/deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-delivery-${previous:0:12}"
mkdir -p "$backup"
git archive --format=tar.gz "$previous" > "$backup/source.tar.gz"
tar -C "$public" -czf "$backup/frontend.tar.gz" .
sudo -n -u postgres pg_dump --format=custom --no-owner --no-acl techtrolley_prod > "$backup/database.dump"
sudo -n -u postgres pg_restore --list < "$backup/database.dump" > "$backup/database-contents.list"
tar -C backend -czf "$backup/media.tar.gz" media
printf '%s\n' "$previous" > "$backup/previous-revision"
printf '%s\n' "$candidate" > "$backup/candidate-revision"
# Restore this exact archive into a private disposable database before changing
# business schema. No backup is copied to the web root.
restore_db=codex_delivery_restore_checkpoint
restore_created=0
activated=0
rollback() {
  code=$?
  trap - ERR
  set +e
  if test "$restore_created" = 1; then sudo -n -u postgres dropdb "$restore_db"; fi
  if test "$activated" = 1; then
    git reset --hard "$previous"
    sudo rm -f "$public/build-revision.txt"
    sudo tar -xzf "$backup/frontend.tar.gz" -C "$public"
    sudo systemctl restart gunicorn
  fi
  echo "Release failed; prior source/frontend restored where possible. Checkpoint: $backup"
  echo 'No business database restore or reverse migration was performed.'
  exit "$code"
}
trap rollback ERR
sudo -n -u postgres createdb --template=template0 "$restore_db"
restore_created=1
sudo -n -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "REVOKE CONNECT ON DATABASE $restore_db FROM PUBLIC" > /dev/null
sudo -n -u postgres pg_restore --exit-on-error --no-owner --no-acl --dbname="$restore_db" < "$backup/database.dump"
sudo -n -u postgres psql -v ON_ERROR_STOP=1 -At -d "$restore_db" -c "SELECT 'restore_ok', COUNT(*) FROM core_asset" > "$backup/restoration-check.txt"
umask 022
activated=1
git reset --hard "$candidate"
sudo -n -u postgres backend/venv/bin/python -B scripts/deployment/rehearse_delivery_migration.py "$PWD/backend" "$restore_db" > "$backup/migration-rehearsal.txt"
sudo -n -u postgres dropdb "$restore_db"
restore_created=0
export DJANGO_ENV=production PYTHONDONTWRITEBYTECODE=1
backend/venv/bin/python -B backend/manage.py check
# Verify the exact pending graph; never apply unrelated audit migrations.
backend/venv/bin/python -B backend/manage.py shell -c "from django.db import connection; from django.db.migrations.executor import MigrationExecutor; e=MigrationExecutor(connection); p=e.migration_plan(e.loader.graph.leaf_nodes()); assert [(m.app_label,m.name,b) for m,b in p] == [('core','0054_program_delivery_documents',False)], 'Unexpected migration plan'"
backend/venv/bin/python -B backend/manage.py migrate core 0054_program_delivery_documents --noinput
backend/venv/bin/python -B backend/manage.py migrate --check
sudo systemctl restart gunicorn
health=https://techtrolley.amaudiovisuals.com
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --resolve techtrolley.amaudiovisuals.com:443:127.0.0.1 "$health/api/company-settings/" > /dev/null
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
echo "Delivery document release active: $candidate. Private restored checkpoint: $backup"
