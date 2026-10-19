@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  GPIC - start the self-hosted site (Node 22 + node:sqlite)
rem
rem  Keep this window open while you use the site.
rem  Admin panel: http://127.0.0.1:4321/admin.html
rem
rem  NOTE: this file MUST keep CRLF line endings. A LF-only .bat
rem  makes cmd shift its read buffer and eat the first characters of
rem  each command. See 同步到公网.bat for the longer explanation.
rem ============================================================

rem -- locate Node 22+ (prefer the managed copy that shipped with WorkBuddy) --
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
rem -- first run: seed the database if it does not exist yet --
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
echo   http://127.0.0.1:4321/
echo   Keep this window open. Press Ctrl+C to stop the server.
echo.
"%NODE%" "%~dp0server\index.mjs"

echo.
echo   Server stopped. Press any key to close.
pause >nul
