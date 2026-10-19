@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  GPIC - start the site so OTHER devices can reach it
rem
rem  Differs from the normal start script in ONE way: it binds
rem  instead of 127.0.0.1, so another machine can open the
rem  admin panel. Use it only while handing over, then close it.
rem
rem  The console prints the real addresses to give people -
rem  never tell them 127.0.0.1, that points at their own PC.
rem
rem  Keep the window open: closing it takes the site down for
rem  everyone you shared it with.
rem
rem  --- RULES FOR EDITING THIS FILE ---
rem  1) PURE ASCII ONLY. cmd parses byte-wise; CJK text under
rem     chcp 65001 desyncs the buffer and eats the first chars
rem     of a line.
rem  2) KEEP CRLF LINE ENDINGS. LF-only shifts the buffer the
rem     same way.
rem  All user-facing Chinese lives in server/index.mjs.
rem ============================================================

rem -- locate Node 22+ (prefer the managed copy) --
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODE%" goto nodefound

set "NODE=node"
where node >nul 2>nul
if %errorlevel%==0 goto nodefound

echo.
echo   Node.js was not found on this computer.
echo   This needs Node 22 or newer (it uses the built-in node:sqlite).
echo.
pause
exit /b 1

:nodefound
if not exist "%~dp0server\data\gpic.sqlite" (
  echo.
  echo   No database found - seeding a new one...
  echo.
  "%NODE%" "%~dp0server\seed.mjs"
)

"%NODE%" "%~dp0server\index.mjs" --host 0.0.0.0 --port 4321

echo.
echo   Server stopped.
pause
