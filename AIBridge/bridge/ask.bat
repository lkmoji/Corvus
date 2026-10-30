@echo off
chcp 65001 >nul
if "%~1"=="" (call "%~dp0chat.bat" & exit /b)
node "%~dp0send.js" %*
