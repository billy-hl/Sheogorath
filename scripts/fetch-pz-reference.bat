@echo off
setlocal

REM ===========================================================================
REM  Project Zomboid reference fetch - run this ON THE PC.
REM
REM  Double-click it. It copies a few read-only files out of your Zomboid
REM  install and sends them up to the Mac: the vanilla weapon scripts, one
REM  vanilla weapon model, and a name listing of the animation folder. Nothing
REM  is modified, nothing is deleted, and nothing from the game is republished -
REM  they are there to read conventions off, because the mod's custom katar was
REM  built on a Mac that has no copy of the game on it.
REM
REM  WHY update-wabbajack-mod.bat CANNOT DO THIS
REM  It runs the other way. That launcher pulls Mac -> PC: it fetches the .ps1,
REM  and the .ps1 fetches the build zip. This one pushes PC -> Mac. Same two
REM  machines, same keys, opposite direction, and no flag on the other script
REM  turns it around.
REM
REM  AND WHY THE MAC CANNOT JUST COME AND GET THEM
REM  There is nothing on this PC for it to connect to. The PC has the OpenSSH
REM  *client* - that is what lets it scp FROM the Mac - and a client does not
REM  accept incoming connections. Turning on an SSH server here would be a
REM  bigger change than running this.
REM
REM  If the game is not found automatically, pass the folder and it is used
REM  as-is. Anything you pass is forwarded straight through:
REM
REM      fetch-pz-reference.bat -GameDir "D:\Steam\steamapps\common\ProjectZomboid"
REM ===========================================================================

set "MAC=dev@192.168.50.131"
set "REMOTE_SCRIPT=/Users/dev/Desktop/Projects/tools/Sheogorath/scripts/fetch-pz-reference.ps1"
set "LOCAL_SCRIPT=%TEMP%\fetch-pz-reference.ps1"

echo.
echo  Project Zomboid reference fetch
echo  -------------------------------

where scp >nul 2>&1
if errorlevel 1 (
    echo.
    echo  FAILED: scp not found.
    echo  Install the Windows OpenSSH client: Settings ^> Apps ^> Optional Features.
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

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCAL_SCRIPT%" %*
if errorlevel 1 (
    echo.
    echo  Nothing was sent. Fix the above and re-run.
    goto :done
)

:done
echo.
pause
endlocal
