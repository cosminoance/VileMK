@echo off
rem Starts VileMK on Windows: the same job as `make design` on Linux and macOS.
setlocal
cd /d "%~dp0"

rem Python: the py launcher from python.org first, then python on PATH.
rem The Microsoft Store alias for python fails the version check below.
set "PY="
where py >nul 2>&1 && py -3 -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && python -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo VileMK needs Python 3.9 or newer, and none was found.
  echo   get it from https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH" in the installer,
  echo   or run:  winget install Python.Python.3.12
  goto :fail
)

rem Node: the range Vite accepts.
where npm >nul 2>&1 || goto :nonode
where node >nul 2>&1 || goto :nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit((a==20&&b>=19)||(a==22&&b>=12)||a>22?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -v') do echo VileMK needs Node.js 20.19 or newer to build its page; this one is %%v.
  goto :nodehint
)
goto :page

:nonode
echo VileMK needs Node.js 20.19 or newer to build its page, and it was not found.
:nodehint
echo   get the LTS version from https://nodejs.org/
echo   or run:  winget install OpenJS.NodeJS.LTS
goto :fail

:page

rem The page: libraries once, then a build every start (a few seconds).
if not exist "web\node_modules" (
  echo ==^> installing the page's libraries, first start only
  pushd web
  call npm ci
  if errorlevel 1 ( popd & goto :fail )
  popd
)
echo ==^> building the page
pushd web
call npm run build
if errorlevel 1 ( popd & goto :fail )
popd

%PY% -m vilemk.webui.server %*
if errorlevel 1 goto :stopped
exit /b 0

:stopped
echo.
echo VileMK stopped. The reason is above. Press any key to close this window.
pause >nul
exit /b 1

:fail
echo.
echo Install what is listed above, close this window, and double-click start.bat again.
pause
exit /b 1
