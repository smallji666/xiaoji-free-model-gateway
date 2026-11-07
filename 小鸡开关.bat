@echo off
title XiaoJi Free Model Console
setlocal

set "PORT=8787"
set "DIR=%~dp0"
set "SERVER=%DIR%server.mjs"
rem Server owns its own log (leveled + size-rolled, keeps 5 backups) -> logs\xiaoji.log
rem Keep server.log untouched: it may still hold older history from previous versions.
set "LOG=%DIR%logs\xiaoji.log"
set "VBS=%DIR%xiaoji-launcher.vbs"

rem Managed Node from WorkBuddy. The versioned dir is REPLACED on every Node upgrade, so a
rem hardcoded probe list goes stale in silence. 2026-09-25 fixed 22.22.2-2 -> 22.22.2-3;
rem by 2026-10-09 that was stale again (real dir: 22.22.2-6) and it fell through to PATH
rem "node" -- which a double-clicked .bat does NOT have, because WorkBuddy injects node only
rem into its own shell. The hidden launcher then died with no console and no log line: the
rem only symptom was "Start failed" next to an empty log. So resolve dynamically instead:
rem   1) the "current" pointer file written by the installer  2) newest versioned dir  3) PATH
set "NODEBASE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions"
set "NODE="
set /p NODEV=<"%NODEBASE%\current" 2>nul
if defined NODEV if exist "%NODEBASE%\%NODEV%\node.exe" set "NODE=%NODEBASE%\%NODEV%\node.exe"
if not defined NODE for /f "delims=" %%d in ('dir /b /ad /o-d "%NODEBASE%" 2^>nul') do (
  if not defined NODE if exist "%NODEBASE%\%%d\node.exe" set "NODE=%NODEBASE%\%%d\node.exe"
)
if not defined NODE set "NODE=node"

rem Falling through to PATH is only safe if PATH really has node. Say so out loud,
rem otherwise the failure is invisible (see above).
if /i "%NODE%"=="node" where node >nul 2>&1 || goto nonode

rem ============ Default action: start gateway HIDDEN, then close ============
call :check
if "%RUN%"=="1" goto already_running
if not exist "%SERVER%" goto nofile
cscript //nologo "%VBS%" "%NODE%" "%SERVER%" "%LOG%"
echo   Starting gateway... (a cold first start can take up to 10s)
call :waitstart
if errorlevel 1 goto startfail
echo.
echo   [OK] XiaoJi Free Model started (hidden background process, no window).
echo        Dashboard:  http://localhost:%PORT%/
echo        API Base:   http://localhost:%PORT%/v1
echo        To stop: run this file, choose [2].
echo.
echo   This window will close in 5 seconds...
timeout /t 5 >nul
goto end

:already_running
echo.
echo   [!] Gateway is already running (hidden in background).
echo       Dashboard:  http://localhost:%PORT%/
echo.
echo   Opening control menu in 4 seconds (choose [2] to stop, [0] to exit)...
timeout /t 4 >nul
goto menu

:nofile
echo.
echo   [x] server.mjs not found:
echo       %SERVER%
echo.
echo   Opening menu in 5 seconds...
timeout /t 5 >nul
goto menu

:nonode
echo.
echo   [x] No usable Node.js found.
echo       Looked in: %NODEBASE%\current
echo                  %NODEBASE%\<version>\node.exe
echo       and on PATH. Reinstall the managed Node, or put node on PATH.
echo.
echo   Opening menu in 6 seconds...
timeout /t 6 >nul
goto menu

:startfail
echo.
echo   [x] Start failed.
echo       Node:  %NODE%
echo       Log:   %LOG%
echo.
echo   Opening menu in 5 seconds...
timeout /t 5 >nul
goto menu

rem ============ Menu ============
:menu
call :check
cls
echo.
echo   ==============================================================
echo       XiaoJi Free Model  -  Local Free LLM Aggregator Console
echo   ==============================================================
if "%RUN%"=="1" goto st_run
echo       Status:  [ STOPPED ]
goto st_done
:st_run
echo       Status:  [ RUNNING ]  (hidden background)  Port %PORT%
:st_done
echo   --------------------------------------------------------------
echo        [1] Start       [2] Stop        [3] Restart
echo        [4] Dashboard   [5] View Log    [0] Exit
echo   --------------------------------------------------------------
echo.
choice /c 123450 /n /m "  Select action: "
set "C=%errorlevel%"
if "%C%"=="1" goto do_start
if "%C%"=="2" goto do_stop
if "%C%"=="3" goto do_restart
if "%C%"=="4" goto do_open
if "%C%"=="5" goto do_log
if "%C%"=="6" goto end
goto menu

:do_start
if "%RUN%"=="1" goto already2
if not exist "%SERVER%" goto nofile
cscript //nologo "%VBS%" "%NODE%" "%SERVER%" "%LOG%"
echo   Starting gateway...
call :waitstart
if errorlevel 1 goto startfail2
echo   [OK] Started (hidden).
timeout /t 2 >nul
goto menu

:already2
echo.
echo   [!] Already running.
timeout /t 2 >nul
goto menu

:startfail2
echo.
echo   [x] Start failed.
echo       Node:  %NODE%
echo       Log:   %LOG%
timeout /t 3 >nul
goto menu

:do_stop
if "%RUN%"=="0" goto notrunning
echo.
echo   [*] Stopping gateway ...
call :killport
timeout /t 2 >nul
call :check
if "%RUN%"=="1" goto stopfail
echo   [OK] Stopped.
timeout /t 2 >nul
goto menu

:stopfail
echo.
echo   [x] Stop failed. Open Task Manager and end the node.exe using port %PORT%.
timeout /t 3 >nul
goto menu

:notrunning
echo.
echo   [!] Gateway is not running.
timeout /t 2 >nul
goto menu

:do_restart
if "%RUN%"=="1" call :killport
timeout /t 2 >nul
goto do_start

:do_open
if "%RUN%"=="0" goto openfail
start "" "http://localhost:%PORT%/"
goto menu

:openfail
echo.
echo   [!] Gateway not running. Start it with [1] first.
timeout /t 2 >nul
goto menu

:do_log
echo.
if not exist "%LOG%" goto nolog
start "" notepad "%LOG%"
goto menu
:nolog
echo   [!] No log file yet.
timeout /t 2 >nul
goto menu

:killport
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING"') do taskkill /PID %%a /F >nul 2>&1
exit /b

:check
set "RUN=0"
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1 && set "RUN=1"
exit /b

rem ---- Wait until the port is really LISTENING (up to ~20s) ----
rem Why not a fixed "timeout /t 3": a cold Node start (first launch after boot, while
rem antivirus is still scanning the 400KB server.mjs) can take ~10s. The old 3s wait hit
rem :check before listen and printed "[x] Start failed" on a perfectly healthy gateway.
:waitstart
set /a __W=0
:__waitloop
call :check
if "%RUN%"=="1" exit /b 0
set /a __W+=1
if %__W% GEQ 20 exit /b 1
timeout /t 1 >nul
goto __waitloop

:end
endlocal
exit /b 0
