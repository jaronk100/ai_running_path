@echo off
rem Starts GraphHopper and the RunPath API in their own windows, then opens the
rem route viewer in your browser. Safe to re-run: anything already running is
rem left alone. Close the two server windows to stop everything.
setlocal
cd /d "%~dp0"

set "JAVA=java"
where java >nul 2>nul || set "JAVA=%JAVA_HOME%\bin\java.exe"

set "JAR="
for %%f in (routing\graphhopper-web-*.jar) do set "JAR=%%~nxf"
if not defined JAR (
  echo GraphHopper jar not found in routing\ -- see docs\setup.md, step 2.
  pause
  exit /b 1
)
if not exist "routing\data\region.osm.pbf" (
  echo Map data missing: routing\data\region.osm.pbf -- see docs\setup.md, step 1.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":8989 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting GraphHopper...
  start "RunPath - GraphHopper" /D routing "%JAVA%" -Xmx4g -jar %JAR% server config.yml
) else (
  echo GraphHopper is already running.
)

if not exist "api\node_modules" (
  echo Installing API dependencies, first run only...
  pushd api
  call npm install
  popd
)

netstat -ano | findstr /r /c:":8080 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting API...
  start "RunPath - API" /D api cmd /k npm run dev
) else (
  echo API is already running.
)

rem /health only returns 200 once the API is up AND can reach GraphHopper.
rem ping is used as the sleep because `timeout` fails without an interactive console.
echo Waiting for both servers...
for /l %%i in (1,1,90) do (
  curl -s -f http://localhost:8080/health >nul 2>nul && goto ready
  ping -n 3 127.0.0.1 >nul
)
echo Timed out after 3 minutes. Check the two server windows for errors.
pause
exit /b 1

:ready
echo Ready. Opening http://localhost:8080/viewer
start "" http://localhost:8080/viewer
