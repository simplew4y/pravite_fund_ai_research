@echo off
setlocal
set "CLAUDE_BIN=%~dp0..\python\Lib\site-packages\claude_agent_sdk\_bundled\claude.exe"
if not exist "%CLAUDE_BIN%" (
  echo claude.exe not found at %CLAUDE_BIN% 1>&2
  exit /b 1
)
"%CLAUDE_BIN%" %*
