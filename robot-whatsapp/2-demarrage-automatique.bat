@echo off
chcp 65001 >nul
cd /d "%~dp0"
net session >nul 2>&1 || (echo Clic droit sur ce fichier puis "Executer en tant qu'administrateur". & pause & exit /b 1)
echo Le robot va demarrer tout seul a chaque redemarrage du VPS.
echo Ferme d'abord la fenetre noire "Robot WhatsApp G37" si elle est ouverte.
pause
schtasks /create /tn "G37 WhatsApp" /tr "\"%~dp01-demarrer.bat\"" /sc onstart /ru SYSTEM /rl HIGHEST /f
schtasks /run /tn "G37 WhatsApp"
echo.
echo C'est fait. Le suivi est dans le fichier bot.log de ce dossier.
pause
