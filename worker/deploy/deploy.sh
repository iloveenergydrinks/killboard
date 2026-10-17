#!/usr/bin/env bash
# Deploys the killboard worker to the replay VM (replay-dashboard, project citadel-replays), from
# this checkout's committed tree:
#
#   worker/deploy/deploy.sh
#
# It uploads worker/ at HEAD as /srv/killboard-worker/releases/<commit>, installs its production
# dependencies there, points /srv/killboard-worker/current at it, installs killboard-worker.service
# and restarts it. The two newest releases are kept, so the previous one is a symlink away.
set -euo pipefail

PROJECT=citadel-replays
ZONE=us-central1-a
HOST=replay-dashboard
ROOT=/srv/killboard-worker

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$repo"
[[ -z $(git status --porcelain -- worker) ]] || { echo "deploy.sh: commit worker/ first" >&2; exit 1; }
commit=$(git rev-parse --short=12 HEAD)
archive=$(mktemp -t killboard-worker.XXXXXX).tar.gz
trap 'rm -f "$archive"' EXIT
git archive --format=tar.gz --prefix="$commit/" HEAD:worker -o "$archive"

ssh=(gcloud compute ssh "$HOST" --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet)
gcloud compute scp "$archive" "$HOST:/tmp/killboard-worker-$commit.tar.gz" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet

"${ssh[@]}" --command "set -euo pipefail
  sudo install -d -o root -g root -m 755 $ROOT/releases
  sudo rm -rf $ROOT/releases/$commit
  sudo tar -xzf /tmp/killboard-worker-$commit.tar.gz -C $ROOT/releases --no-same-owner
  rm -f /tmp/killboard-worker-$commit.tar.gz
  cd $ROOT/releases/$commit
  sudo npm ci --omit=dev --no-audit --no-fund --loglevel=error
  sudo ln -sfn $ROOT/releases/$commit $ROOT/current.next
  sudo mv -Tf $ROOT/current.next $ROOT/current
  sudo install -m 644 deploy/killboard-worker.service /etc/systemd/system/killboard-worker.service
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet killboard-worker
  sudo systemctl restart killboard-worker
  sleep 15
  systemctl is-active killboard-worker
  sudo journalctl -u killboard-worker --since '-20s' --no-pager -o cat | grep -v ExperimentalWarning | tail -3
  ls -1dt $ROOT/releases/*/ | tail -n +3 | xargs -r sudo rm -rf"
echo "deployed killboard worker $commit"
