@echo off
rem Double-click: collects new demos (pnpm grab) and makes the clips (pnpm go). GUIDE.md.
cd /d "%~dp0"
echo == Collecting new demos
call pnpm grab
echo.
echo == Making clips (CS2 opens by itself; keep your hands off it)
call pnpm go
set CODE=%ERRORLEVEL%
echo.
if %CODE%==0 (
  echo Done. Your clips: library\index.html
) else (
  echo No new clips: pnpm go ended with code %CODE%. The lines above say why; GUIDE.md, 'If something goes wrong'.
)
pause
exit /b %CODE%
