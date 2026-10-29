@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI Bridge - чат
where node >nul 2>nul || (echo Node.js не найден. Установи: winget install OpenJS.NodeJS.LTS & pause & exit /b)
node chat.js
pause
