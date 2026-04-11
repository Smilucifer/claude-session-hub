@echo off
cd /d "%~dp0"
echo Building...
call npm run build >nul 2>&1
start "" http://localhost:3456
npm start
