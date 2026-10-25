@echo off
rem Double-click: asks for the three Valve matchmaking values (pnpm prep --valve). GUIDE.md.
cd /d "%~dp0"
call pnpm prep --valve
set CODE=%ERRORLEVEL%
echo.
if %CODE%==0 (
  echo Done. Matchmaking demos are collected by pnpm grab and Make clips.cmd.
) else (
  echo Matchmaking is not set up yet: pnpm prep --valve ended with code %CODE%. The lines above say what is missing; GUIDE.md.
)
pause
exit /b %CODE%
