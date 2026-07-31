@echo off
start "Agentic Command Center" powershell -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0guards-gui.ps1"
