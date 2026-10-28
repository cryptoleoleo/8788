@echo off
setlocal
set "EXT_DIR=%~dp0"
set "PROFILE=%LOCALAPPDATA%\BAW-Original-Multi\ChromeExtensionProfile"
set "BAW_START=%LOCALAPPDATA%\BAW-Original-Multi\program\Start-BAW.cmd"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"

if not exist "%EXT_DIR%\manifest.json" goto missing_extension
if not exist "%CHROME%" goto missing_chrome

curl.exe --noproxy "*" --silent --fail --max-time 2 "http://127.0.0.1:8787/api/health" >nul 2>&1
if not errorlevel 1 goto service_ready
if not exist "%BAW_START%" goto missing_service

echo Starting the BAW local service...
start "BAW local service - keep this window open" "%BAW_START%"
for /L %%I in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  curl.exe --noproxy "*" --silent --fail --max-time 2 "http://127.0.0.1:8787/api/health" >nul 2>&1
  if not errorlevel 1 goto service_ready
)
goto service_timeout

:service_ready
start "" "%CHROME%" --user-data-dir="%PROFILE%" --load-extension="%EXT_DIR%" --no-first-run --no-default-browser-check --new-window "https://gmgn.ai/?chain=bsc&ref=qimeme"
exit /b 0

:missing_extension
echo Extension files were not found beside this launcher.
pause
exit /b 1

:missing_chrome
echo Google Chrome was not found at its standard installation path.
pause
exit /b 1

:missing_service
echo The BAW local service launcher was not found.
pause
exit /b 1

:service_timeout
echo The BAW service did not become ready. Check its console window.
pause
exit /b 1

