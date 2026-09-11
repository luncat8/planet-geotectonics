#!/bin/sh
# Opens the WebGPU smoke test in the default browser (double-click me).
# After it runs: click "Save log" and drop the .log into experiments/logs/.
cd "$(dirname "$0")" || exit 1
xdg-open webgpu-smoke.html 2>/dev/null || open webgpu-smoke.html
