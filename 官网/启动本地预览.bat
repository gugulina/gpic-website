@echo off
setlocal
cd /d "%~dp0"

set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if exist "%PY%" goto run

set "PY=py"
where py >nul 2>nul
if %errorlevel%==0 goto run

set "PY=python"
where python >nul 2>nul
if %errorlevel%==0 goto run

echo.
echo   Python 3 was not found on this computer.
echo   Install Python 3, then run this file again.
echo.
pause
exit /b 1

:run
echo.
echo   Starting local server for the GPIC website...
echo   (Close this window to stop the server.)
echo.
"%PY%" "%~dp0scripts\serve.py"

echo.
echo   Server stopped. Press any key to close.
pause >nul
