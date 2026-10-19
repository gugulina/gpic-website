@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  GPIC - sync admin-panel content to the public site
rem
rem  Lives in the REPO ROOT, next to .git and .github, because
rem  step 3 is a repo-level operation (git push), not a site file.
rem
rem  Runs:  node sync-public.mjs
rem   [1/3] export SQLite DB        -> data/content.json
rem   [2/3] rebuild static snapshot -> web-standalone/
rem   [3/3] git commit + git push   -> GitHub Pages republishes
rem
rem  Step 3 is the one that actually puts content online.
rem  Saving in the admin panel only writes the local database.
rem
rem  --- THREE RULES FOR EDITING THIS FILE ---
rem  1) PURE ASCII ONLY. cmd parses batch files byte-wise; with
rem     chcp 65001 active, CJK text desyncs the read buffer and
rem     swallows the first characters of a line, showing up as
rem     "'...' is not recognized as an internal or external command".
rem     All Chinese UI text lives in sync-public.mjs instead.
rem     (This is also why we call "%~dp0sync-public.mjs" and not
rem      a path through the CJK-named site folder.)
rem  2) KEEP CRLF LINE ENDINGS. A LF-only .bat shifts the read
rem     buffer the same way ("'cho' is not recognized").
rem  3) Keep both this file and sync-public.mjs in the repo root.
rem ============================================================

rem -- locate Node 22+ (prefer the managed copy) --
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODE%" goto run

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode

:run
"%NODE%" "%~dp0sync-public.mjs" %*
if errorlevel 1 goto failed

echo.
pause
exit /b 0

:failed
echo.
echo   Sync failed - nothing was pushed. See the message above.
echo.
pause
exit /b 1

:nonode
echo.
echo   Node.js 22 or newer was not found.
echo   This script needs Node 22+ because it uses the built-in node:sqlite.
echo.
pause
exit /b 1
