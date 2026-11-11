@echo off
rem Double-click to start KLIPZ (web app + worker). Close this window or press Ctrl+C to stop both.
cd /d "%~dp0"
title KLIPZ
call npm start
if errorlevel 1 (
  echo.
  echo KLIPZ stopped with an error. Read the messages above.
  pause
)
