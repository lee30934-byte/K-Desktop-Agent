@echo off
if "%~1"=="--version" (
  echo codex-cli 0.158.0
  exit /b 0
)
node "%~dp0mock-elicitation-server.mjs" %*
