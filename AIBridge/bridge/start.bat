@echo off
start "AI Bridge" "%~dp0bridge.bat"
timeout /t 1 /nobreak >nul
call "%~dp0chat.bat"
