@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  GPIC - three-layer backup
rem
rem    backup\gpic-<timestamp>\           full file copy (runnable)
rem    backup\db\gpic-<timestamp>.sqlite  consistent DB snapshot
rem    backup\gpic-<timestamp>.bundle     complete git history
rem
rem  See backup\README.md for how to restore.
rem
rem  NOTE: this file MUST keep CRLF line endings. A LF-only .bat
rem  makes cmd shift its read buffer and eat the first characters of
rem  each command. See the sync .bat in the project root for details.
rem ============================================================

rem -- locate Node 22+ (prefer the managed copy that shipped with WorkBuddy) --
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
"%NODE%" "%~dp0backup\_tools\gpic-backup.mjs" %*

echo.
echo   Press any key to close.
pause >nul
