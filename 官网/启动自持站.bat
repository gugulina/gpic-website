@echo off
setlocal
cd /d "%~dp0"

rem ── 找 Node 22+（优先用 WorkBuddy 自带的受管版本）──────────────
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODE%" goto nodefound

set "NODE=node"
where node >nul 2>nul
if %errorlevel%==0 goto nodefound

echo.
echo   Node.js was not found on this computer.
echo   This site needs Node 22 or newer (it uses the built-in node:sqlite).
echo   Install Node 22+, then run this file again.
echo.
pause
exit /b 1

:nodefound
rem ── 首次运行：数据库不存在就先灌数据 ────────────────────────
if not exist "%~dp0server\data\gpic.sqlite" (
  echo.
  echo   First run detected - seeding the database...
  echo.
  "%NODE%" "%~dp0server\seed.mjs"
  echo.
  echo   ---- IMPORTANT ----
  echo   If a random password was printed above, write it down NOW.
  echo   It is shown only once and cannot be recovered.
  echo   -------------------
  pause
)

echo.
echo   Starting the self-hosted GPIC website...
echo   Keep this window open. Press Ctrl+C to stop the server.
echo.
"%NODE%" "%~dp0server\index.mjs"

echo.
echo   Server stopped. Press any key to close.
pause >nul
