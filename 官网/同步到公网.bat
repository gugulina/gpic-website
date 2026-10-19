@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  GPIC - sync database content into the static snapshot
rem
rem  Run this AFTER editing content in the admin panel.
rem  It exports the SQLite database back to data\content.json and
rem  rebuilds web-standalone\ (what GitHub Pages actually serves).
rem
rem  It does NOT touch git. Commit and push yourself afterwards.
rem
rem  NOTE: this file MUST keep CRLF line endings. Windows cmd reads
rem  batch files in CRLF blocks; a LF-only .bat gets a shifted buffer
rem  and silently eats the first characters of each command, which
rem  shows up as "'cho' is not recognized as an internal command".
rem ============================================================

rem -- locate Node 22+ (prefer the managed copy that shipped with WorkBuddy) --
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODE%" goto nodefound

set "NODE=node"
where node >nul 2>nul
if %errorlevel%==0 goto nodefound

echo.
echo   Node.js was not found.
echo   This needs Node 22 or newer (it uses the built-in node:sqlite).
echo.
pause
exit /b 1

:nodefound
if not exist "%~dp0server\data\gpic.sqlite" (
  echo.
  echo   No database found at server\data\gpic.sqlite
  echo   Run "启动自持站.bat" first - it seeds the database on first run.
  echo.
  pause
  exit /b 1
)

echo.
echo   [1/2] Exporting database content to data\content.json ...
echo.
"%NODE%" "%~dp0server\export.mjs"
if errorlevel 1 (
  echo.
  echo   Export failed - nothing was written.
  echo.
  pause
  exit /b 1
)

echo.
echo   [2/2] Rebuilding the static snapshot (web-standalone\) ...
echo.

rem -- locate Python 3 (prefer the managed copy; skip the Microsoft Store stub,
rem    which would pop up the Store instead of running) --
set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if exist "%PY%" goto pyfound

set "PY="
for /f "delims=" %%P in ('where python 2^>nul ^| find /i /v "WindowsApps"') do (
  if not defined PY set "PY=%%P"
)
if not defined PY goto nopython
goto pyfound

:nopython
echo.
echo   Python 3 was not found.
echo   This step needs Python 3 to rebuild the static snapshot.
echo.
pause
exit /b 1

:pyfound
"%PY%" "%~dp0scripts\build-standalone.py"
if errorlevel 1 (
  echo.
  echo   Build failed. Check that Python 3 can run scripts\build-standalone.py
  echo.
  pause
  exit /b 1
)

echo.
echo   ------------------------------------------------------------
echo   Done. Updated:
echo     data\content.json
echo     web-standalone\
echo.
echo   Next step is manual - commit and push:
echo     git add -A
echo     git commit -m "content: sync from admin panel"
echo     git push
echo.
echo   GitHub Pages will rebuild automatically after the push.
echo   ------------------------------------------------------------
echo.
pause
