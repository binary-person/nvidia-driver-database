#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

SESSION_NAME="nvidia-driver-database-daily"
LOG_FILE="$SCRIPT_DIR/tmux.log"
MAX_LOG_SIZE=$((1024 * 1024))
MAX_ROTATED_LOGS=4

TMUX_COMMAND=$(cat <<EOF
cd $(printf '%q' "$SCRIPT_DIR") || exit 1
set -euo pipefail
LOG_FILE=$(printf '%q' "$LOG_FILE")
MAX_LOG_SIZE=$MAX_LOG_SIZE
MAX_ROTATED_LOGS=$MAX_ROTATED_LOGS

rotate_log() {
  local size
  local index

  if [[ -f "\$LOG_FILE" ]]; then
    size=\$(wc -c < "\$LOG_FILE")
    if (( size >= MAX_LOG_SIZE )); then
      rm -f "\${LOG_FILE}.\${MAX_ROTATED_LOGS}"
      for ((index = MAX_ROTATED_LOGS - 1; index >= 1; index--)); do
        if [[ -f "\${LOG_FILE}.\${index}" ]]; then
          mv -f "\${LOG_FILE}.\${index}" "\${LOG_FILE}.\$((index + 1))"
        fi
      done
      mv -f "\$LOG_FILE" "\${LOG_FILE}.1"
    fi
  fi
}

rotate_log

./daily.sh 2>&1 | while IFS= read -r line || [[ -n "\$line" ]]; do
  rotate_log
  printf '%s\n' "\$line" | tee -a "\$LOG_FILE"
done
EOF
)

tmux new-session -d -s "$SESSION_NAME" "bash -lc $(printf '%q' "$TMUX_COMMAND")"
