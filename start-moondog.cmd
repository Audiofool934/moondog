@echo off
setlocal
cd /d "%~dp0"
if not defined MOONDOG_LANGUAGE set "MOONDOG_LANGUAGE=zh"
call npm.cmd --prefix app start
if errorlevel 1 pause
