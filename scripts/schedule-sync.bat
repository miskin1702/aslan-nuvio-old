@echo off
REM Project Aslan - Master 5x Daily Update Task Creator for Windows
REM Schedules update-all.js to run 5 times a day: 11:30, 15:30, 18:30, 20:30, 22:30

set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=node.exe"

echo [Project Aslan] Configuring 5x daily automated update tasks for all providers...

schtasks /create /tn "Aslan_MasterUpdate_1" /tr "\"%NODE_EXE%\" \"%SCRIPT_DIR%update-all.js\"" /sc daily /st 11:30 /f
schtasks /create /tn "Aslan_MasterUpdate_2" /tr "\"%NODE_EXE%\" \"%SCRIPT_DIR%update-all.js\"" /sc daily /st 15:30 /f
schtasks /create /tn "Aslan_MasterUpdate_3" /tr "\"%NODE_EXE%\" \"%SCRIPT_DIR%update-all.js\"" /sc daily /st 18:30 /f
schtasks /create /tn "Aslan_MasterUpdate_4" /tr "\"%NODE_EXE%\" \"%SCRIPT_DIR%update-all.js\"" /sc daily /st 20:30 /f
schtasks /create /tn "Aslan_MasterUpdate_5" /tr "\"%NODE_EXE%\" \"%SCRIPT_DIR%update-all.js\"" /sc daily /st 22:30 /f

echo [Project Aslan] All 5 scheduled tasks created successfully.
