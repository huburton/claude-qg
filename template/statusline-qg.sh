#!/bin/bash
# Statusline of the sessions started from the hub directory (QG + workers): keeps a copy of the JSON Claude Code
# sends it (context, 5 h / 7 d quotas) so the hub can read `rate_limits` before launching several expensive workers,
# then delegates the display to your own statusline command (optional).
# One file per session: ~/.local/state/qg/statusline/<session_id>.json
input=$(cat)
dir="${QG_STATE:-$HOME/.local/state/qg}/statusline"
sid=$(printf '%s' "$input" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id",""))
except Exception: pass' 2>/dev/null)
if [ -n "$sid" ]; then
    mkdir -p "$dir" && printf '%s' "$input" > "$dir/.$sid.tmp" && mv -f "$dir/.$sid.tmp" "$dir/$sid.json"
fi
if [ -n "$QG_STATUSLINE_CMD" ]; then printf '%s' "$input" | bash -c "$QG_STATUSLINE_CMD"; else echo "QG"; fi
