@echo off
rem Opens the WebGPU smoke test in the default browser (double-click me).
rem After it runs: click "Save log" and drop the .log into experiments\/.
start "" "%~dp0webgpu-smoke.html"
timeout /t 2 >nul
