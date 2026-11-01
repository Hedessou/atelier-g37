@echo off
chcp 65001 >nul
cd /d "%~dp0"
schtasks /end /tn "G37 WhatsApp" >nul 2>&1
if exist bot.pid (for /f %%p in (bot.pid) do taskkill /pid %%p /t /f >nul 2>&1)
echo Robot WhatsApp G37 arrete.
echo (Pour supprimer le demarrage automatique : schtasks /delete /tn "G37 WhatsApp" /f)
pause
