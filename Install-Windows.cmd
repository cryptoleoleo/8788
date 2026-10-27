@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
if not defined BAW_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined BAW_NODE set "BAW_NODE=%%N"
if not defined BAW_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "BAW_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined BAW_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "BAW_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined BAW_NODE if exist "%NVM_SYMLINK%\node.exe" set "BAW_NODE=%NVM_SYMLINK%\node.exe"
if not defined BAW_NODE goto missing_node
if not exist "%BAW_NODE%" goto missing_node
set "BAW_SOURCE=%~dp0program"
if not exist "%BAW_SOURCE%\windows-install.mjs" set "BAW_SOURCE=%~dp0."
"%BAW_NODE%" "%BAW_SOURCE%\windows-install.mjs" --source "%BAW_SOURCE%" %*
set "BAW_EXIT=%ERRORLEVEL%"
if not "%BAW_NONINTERACTIVE%"=="1" pause
exit /b %BAW_EXIT%
:missing_node
echo Node.js was not found. Install Node.js 24 LTS from https://nodejs.org/ and reopen this window.
if not "%BAW_NONINTERACTIVE%"=="1" pause
exit /b 1
