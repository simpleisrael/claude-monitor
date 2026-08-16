#!/bin/bash
# SwiftBar/xbar plugin — worst Claude session context % in the menu bar.
# All formatting lives server-side in /api/menubar; this just relays it.
curl -sf --max-time 3 http://127.0.0.1:4599/api/menubar 2>/dev/null \
  || printf '⚪ CC\n---\nMonitor daemon offline\nStart: node monitor.js install | font=Menlo size=12\n'
