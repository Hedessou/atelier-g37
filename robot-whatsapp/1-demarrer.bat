@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Robot WhatsApp G37
where node >nul 2>nul || (echo Node.js n'est pas installe. Installe-le depuis https://nodejs.org puis relance. & pause & exit /b 1)
if not exist node_modules (
  echo Installation des modules, patiente...
  call npm install --omit=dev
)
:boucle
node bot.js
echo.
echo Le robot s'est arrete - redemarrage dans 10 secondes...
timeout /t 10 /nobreak >nul
goto boucle
