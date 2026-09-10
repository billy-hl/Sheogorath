@echo off
setlocal

REM ===========================================================================
REM  Wabbajack Server Toolkit - update the Workshop project on this PC.
REM
REM  Double-click this. It does the dry run first, shows you what would change,
REM  and only installs if you say yes.
REM
REM  WHY THIS FETCHES THE .PS1 INSTEAD OF SITTING NEXT TO A COPY OF IT
REM  The real script lives in the repo on the Mac, which is where it gets
REM  edited. A copy on this PC would be a second version of it: it would work
REM  for a while, then quietly stop matching, and the failure would look like
REM  "the upload did nothing" rather than "you ran last month's script". So the
REM  only thing that lives on this PC is this launcher, and it pulls the
REM  current script every time.
REM
REM  TO CHANGE THE WORK DIRECTORY, EDIT THE SET LINE BELOW - do not pass
REM  -WorkDir as an argument. Anything you pass is forwarded to PowerShell as
REM  well as the value here, and PowerShell rejects the same parameter twice.
REM  Arguments that are NOT -WorkDir (-DryRun, -ProjectDir, ...) are fine, and
REM  passing any argument skips the prompt below and just runs it.
REM ===========================================================================

set "MAC=dev@192.168.50.131"
set "REMOTE_SCRIPT=/Users/dev/Desktop/Projects/tools/Sheogorath/scripts/update-wabbajack-mod.ps1"
set "WORKDIR=%USERPROFILE%\Downloads"
set "LOCAL_SCRIPT=%TEMP%\update-wabbajack-mod.ps1"

echo.
echo  Wabbajack Server Toolkit - Workshop project update
echo  --------------------------------------------------

where scp >nul 2>&1
if errorlevel 1 (
    echo.
    echo  FAILED: scp not found.
    echo  Install the Windows OpenSSH client: Settings ^> Apps ^> Optional Features.
    goto :done
)

if not exist "%WORKDIR%" mkdir "%WORKDIR%" >nul 2>&1
if not exist "%WORKDIR%" (
    echo.
    echo  FAILED: could not create %WORKDIR%.
    echo  Edit the WORKDIR line at the top of this file.
    goto :done
)

echo.
echo  Fetching the current script from the Mac...
scp -q "%MAC%:%REMOTE_SCRIPT%" "%LOCAL_SCRIPT%"
if errorlevel 1 (
    echo.
    echo  FAILED: could not fetch the script from %MAC%.
    echo.
    echo  Read the scp line above before assuming the Mac is asleep - scp exits
    echo  the same way for a missing FILE as for an unreachable HOST:
    echo.
    echo    "No such file or directory"  the connection was FINE. The path is
    echo                                 wrong - REMOTE_SCRIPT at the top of
    echo                                 this file no longer matches where the
    echo                                 repo lives on the Mac.
    echo    anything else                the Mac is asleep, off, or Remote
    echo                                 Login is off. Try:  ssh %MAC%
    goto :done
)
if not exist "%LOCAL_SCRIPT%" (
    echo.
    echo  FAILED: scp reported success but %LOCAL_SCRIPT% is not there.
    goto :done
)
echo  OK

REM Arguments given: forward them and get out of the way.
if not "%~1"=="" goto :passthrough

REM ------------------------------------------------------ dry run, then ask
echo.
echo  ---------------------------- DRY RUN ----------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCAL_SCRIPT%" -WorkDir "%WORKDIR%" -DryRun
if errorlevel 1 (
    echo.
    echo  The dry run failed. Nothing was changed. Fix the above and re-run.
    goto :done
)

echo.
set "ANS="
set /p "ANS=  Install it? [y/N] "
if /i not "%ANS%"=="y" (
    echo.
    echo  Nothing installed.
    goto :done
)

echo.
echo  --------------------------- INSTALLING ---------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCAL_SCRIPT%" -WorkDir "%WORKDIR%"
if errorlevel 1 (
    echo.
    echo  The install failed. The script restores the previous version on its
    echo  way out, so the working copy should be exactly as it was.
    goto :done
)

echo.
echo  Now upload it from the game:  Workshop ^> WabbajackSiege ^> Update
goto :done

REM ------------------------------------------------------------ passthrough
:passthrough
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCAL_SCRIPT%" -WorkDir "%WORKDIR%" %*

:done
echo.
pause
endlocal
