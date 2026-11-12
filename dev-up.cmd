@echo off
rem ===========================================================================
rem  DriveLoom local launcher (Windows).  Double-click, then press a number.
rem  Needs only git and Docker Desktop.  See "Local development launcher" in
rem  README.md.  Never writes to deploy\.env.
rem ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title DriveLoom launcher

rem ---- Settings you may want to change --------------------------------------
set "BASEFILE=deploy\compose.yml"
set "OVERRIDE=deploy\compose.override.yml"
set "OVERRIDE_ALT=deploy\compose.override.yaml"
set "ENVFILE=deploy\.env"
set "LOG=%TEMP%\driveloom-dev-up.log"

rem ---- ANSI escape character, for the green banner ---------------------------
set "ESC="
for /f %%E in ('echo prompt $E ^| cmd') do set "ESC=%%E"

rem ---- Preflight: tools, Docker running, compose files, .env -------------------
:preflight
where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: git was not found on PATH. Install Git for Windows first.
  goto :fatal
)
where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: docker was not found on PATH. Install Docker Desktop first.
  goto :fatal
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker is not running yet.
  echo Please start Docker Desktop, wait until it says "running", then try again.
  goto :fatal
)
if not exist "%BASEFILE%" (
  echo ERROR: %BASEFILE% not found. Run this script from the DriveLoom checkout.
  goto :fatal
)

rem Build the compose arguments: base file, optional local override, optional .env.
set "DCARGS=-f %BASEFILE%"
if exist "%OVERRIDE%" set "DCARGS=%DCARGS% -f %OVERRIDE%"
if exist "%OVERRIDE_ALT%" set "DCARGS=%DCARGS% -f %OVERRIDE_ALT%"
if exist "%ENVFILE%" (
  set "DCARGS=%DCARGS% --env-file %ENVFILE%"
) else (
  echo.
  echo WARNING: %ENVFILE% is missing. Starting will fail without it.
  echo          Copy deploy\.env.example to deploy\.env and fill it in.
  echo          This script never creates or overwrites that file.
  echo.
)

rem ---- Main menu --------------------------------------------------------------
:menu
echo.
echo %ESC%[92m=== DriveLoom (built from local source) ===%ESC%[0m
echo   1  Start it as you left it (keeps your data)
echo   2  Stop the app without quitting (keeps data)
echo   3  Show live logs (press Ctrl+C, then N, to come back here)
echo   4  Restart and apply updates (pulls the current branch if clean, rebuilds, keeps data)
echo   5  Wipe everything and start completely fresh (DELETES the database, asks first)
echo   6  Quit (leaves the app as it is)
set "CHOICE="
set /p "CHOICE=Choose 1, 2, 3, 4, 5 or 6: "
if "%CHOICE%"=="1" goto :do_start
if "%CHOICE%"=="2" goto :do_stop
if "%CHOICE%"=="3" goto :do_logs
if "%CHOICE%"=="4" goto :do_update
if "%CHOICE%"=="5" goto :do_reset
if "%CHOICE%"=="6" goto :quit
echo Please type a number from 1 to 6.
goto :menu

rem ---- 1: start ---------------------------------------------------------------
:do_start
docker compose %DCARGS% up -d --quiet-pull --wait
if errorlevel 1 goto :failed
call :print_url
goto :menu

rem ---- 2: stop (containers removed, database volume kept) ---------------------
:do_stop
docker compose %DCARGS% down
if errorlevel 1 goto :failed
goto :menu

rem ---- 3: logs ----------------------------------------------------------------
:do_logs
docker compose %DCARGS% logs -f --tail 100
goto :menu

rem ---- 4: restart and apply updates --------------------------------------------
:do_update
rem Pull the branch you are on (fast-forward only), but only when it is safe.
set "CUR="
for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CUR=%%B"
if /i "%CUR%"=="HEAD" (
  echo Git: skipped pull, you are on a detached HEAD.
  goto :pull_done
)
set "UPSTREAM="
for /f "delims=" %%U in ('git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2^>nul') do set "UPSTREAM=%%U"
if not defined UPSTREAM (
  echo Git: skipped pull, "%CUR%" has no upstream branch.
  goto :pull_done
)
set "DIRTY="
for /f "delims=" %%L in ('git status --porcelain --untracked-files=no 2^>nul') do set "DIRTY=1"
if defined DIRTY (
  echo Git: skipped pull, you have uncommitted changes. Commit or stash them to pull.
  goto :pull_done
)
set "OLDHEAD="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "OLDHEAD=%%H"
git pull --ff-only >"%LOG%" 2>&1
if errorlevel 1 (
  type "%LOG%"
  echo.
  echo ERROR: git pull --ff-only failed on "%CUR%". It has probably diverged from "%UPSTREAM%".
  echo        Fix it by hand, for example with git status and git log, then try again.
  goto :failed
)
set "NEWHEAD="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "NEWHEAD=%%H"
if "%OLDHEAD%"=="%NEWHEAD%" (
  echo Git: already up to date.
) else (
  echo Git: updated %CUR%.
)
:pull_done

docker compose %DCARGS% pull --quiet --ignore-buildable >"%LOG%" 2>&1
if errorlevel 1 echo Could not pull images (offline?). Continuing with what is installed.

docker compose --progress quiet %DCARGS% build >"%LOG%" 2>&1
if errorlevel 1 (
  type "%LOG%"
  echo.
  echo ERROR: the build failed. The output above is the full build log.
  goto :failed
)

docker compose %DCARGS% up -d --quiet-pull --wait
if errorlevel 1 (
  echo.
  echo ERROR: the containers did not start or did not become healthy.
  echo        Choose option 3 to read the logs.
  goto :failed
)
call :print_url
echo Updated. Hard refresh the page with Ctrl+F5 so the browser drops old files.
goto :menu

rem ---- 5: reset (deletes volumes) -----------------------------------------------
:do_reset
echo.
echo This stops DriveLoom and DELETES its database and every stored photo.
set "CONFIRM="
set /p "CONFIRM=Type YES (capitals) to continue, anything else cancels: "
if not "%CONFIRM%"=="YES" (
  echo Cancelled. Nothing was deleted.
  goto :menu
)
docker compose %DCARGS% down -v
if errorlevel 1 goto :failed
echo Everything was wiped. Choose 1 to start fresh.
goto :menu

rem ---- Print the address to open (no browser is launched) --------------------------
:print_url
set "ORIGIN="
set "TOKEN="
set "PORT=8080"
if exist "%ENVFILE%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ENVFILE%") do (
    if /i "%%A"=="DRIVELOOM_PUBLIC_ORIGIN" set "ORIGIN=%%B"
    if /i "%%A"=="DRIVELOOM_PORT" if not "%%B"=="" set "PORT=%%B"
    if /i "%%A"=="DRIVELOOM_SETUP_TOKEN" if not "%%B"=="" set "TOKEN=%%B"
  )
)
echo.
echo   On this PC:  http://127.0.0.1:%PORT%
if defined ORIGIN echo   Public URL:  %ORIGIN%  (through your reverse proxy)
echo.
rem First-run setup: ask the app whether any account exists yet. Prints the token
rem only while setup is still needed. It is read from deploy\.env and shown on
rem screen only; it is never written to the log or a temp file.
where curl >nul 2>&1
if errorlevel 1 exit /b 0
curl -s --max-time 5 "http://127.0.0.1:%PORT%/v1/auth/instance" 2>nul | findstr /r "needs_setup.:.true" >nul 2>&1
if errorlevel 1 exit /b 0
echo %ESC%[93mFirst-time setup is needed: no account exists yet.%ESC%[0m
echo   Open http://127.0.0.1:%PORT% and register; the first account becomes the administrator.
if defined TOKEN (
  echo   Setup token: %TOKEN%
) else (
  echo   No setup token is set in %ENVFILE%, so none is asked for.
)
echo.
exit /b 0

rem ---- Error handling: keep the window open ---------------------------------------
:failed
echo.
echo Something went wrong. See the messages above.
pause
goto :menu

:fatal
echo.
pause
exit /b 1

:quit
endlocal
exit /b 0
