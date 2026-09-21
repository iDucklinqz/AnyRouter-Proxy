@echo off
rem ============================================================
rem  Start the Claude Code front proxy (cc-proxy.js)
rem
rem  Usage:
rem    start-cc.bat                      -> prompts for upstream URL
rem                                         (press Enter = built-in default)
rem    start-cc.bat https://your.host    -> uses the given upstream
rem
rem  Port: 8118  (change PROXY_PORT below if needed)
rem  API keys are passed through untouched - nothing to enter here,
rem  CC sends its own key and the proxy forwards it as-is.
rem
rem  NOTE: keep this file ASCII-only (GBK console misparses UTF-8).
rem ============================================================
setlocal EnableExtensions
set "PROXY_PORT=8118"

rem ---- upstream: 1st argument > interactive prompt > built-in default ----
set "UPSTREAM_INPUT=%~1"
if not defined UPSTREAM_INPUT set /p "UPSTREAM_INPUT=Enter upstream URL (press Enter for built-in default): "

rem ---- if the port is already in use, stop the old proxy first ----
set "OLDPID="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /r /c:":%PROXY_PORT% .*LISTENING"') do set "OLDPID=%%P"
if defined OLDPID (
  tasklist /fi "PID eq %OLDPID%" /fo csv /nh 2>nul | findstr /i "node.exe" >nul
  if not errorlevel 1 (
    echo [cc-proxy] stopping old instance on port %PROXY_PORT% ...
    taskkill /f /pid %OLDPID% >nul 2>&1
    ping -n 2 127.0.0.1 >nul
  ) else (
    echo [cc-proxy] port %PROXY_PORT% is occupied by a non-node process, aborting.
    pause
    exit /b 1
  )
)

if defined UPSTREAM_INPUT (
  echo [cc-proxy] upstream: %UPSTREAM_INPUT%
  set "UPSTREAM=%UPSTREAM_INPUT%"
) else (
  echo [cc-proxy] upstream: built-in default
)

echo [cc-proxy] starting front proxy at http://127.0.0.1:%PROXY_PORT% ...
node "%~dp0cc-proxy.js" %PROXY_PORT%
echo [cc-proxy] proxy exited.
pause
endlocal
