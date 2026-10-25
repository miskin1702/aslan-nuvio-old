#!/usr/bin/env bash
# Project Aslan - Master 5x Daily Update Cron Configuration
# Runs update-all.js at 11:30, 15:30, 18:30, 20:30, 22:30 (Turkey Time / Match Preparation)

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/update-all.js"
NODE_PATH="$(which node || echo /usr/bin/node)"

CRON_JOB="30 11,15,18,20,22 * * * $NODE_PATH $SCRIPT_PATH >> /tmp/aslan-master-update.log 2>&1"

(crontab -l 2>/dev/null | grep -v "update-all.js"; echo "$CRON_JOB") | crontab -
echo "[Project Aslan] Crontab updated to run update-all.js 5 times daily at 11:30, 15:30, 18:30, 20:30, 22:30."
