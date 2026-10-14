#!/bin/bash
# Launches the hub session (run it inside tmux, e.g. from a systemd user unit):
# Remote Control + the "qg" channel, resumes the previous conversation, restarts Claude Code if it exits.
# Stop: systemctl --user stop qg      See the screen: tmux attach -t qg (detach: Ctrl+B then D)
# Adapt HUB_DIR, the session name and the permission mode to your own trust level.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
HUB_DIR="${HUB_DIR:-$HOME/qg}"
# Nobody looks at this tmux terminal: without this, Claude Code thinks the user is present and pushes no notification.
export CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK=1
cd "$HUB_DIR" || exit 1

accept_dev_channel_warning() {
    # A home-made channel is not on Anthropic's allowlist: Claude Code shows a warning at every start.
    # Confirm it only when it is actually on screen.
    for _ in $(seq 60); do
        sleep 1
        if tmux capture-pane -p -t qg 2>/dev/null | grep -q "Loading development channels"; then
            tmux send-keys -t qg Enter
            return
        fi
    done
}

while true; do
    accept_dev_channel_warning &
    # Auto-compact at ~500k tokens (instead of ~967k on the 1M model) to limit the cost of each message.
    args=(--name QG --remote-control QG --permission-mode bypassPermissions --autocompact 500000
          --dangerously-load-development-channels server:qg)
    # `claude --continue` resumes the last conversation of this directory, if there is one.
    if ls "$HOME/.claude/projects/"*"$(basename "$HUB_DIR")"/*.jsonl >/dev/null 2>&1; then
        claude --continue "${args[@]}"
    else
        claude "${args[@]}"
    fi
    sleep 10
done
