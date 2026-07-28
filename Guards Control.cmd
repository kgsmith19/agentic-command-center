@echo off
start "" powershell -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0guards-gui.ps1"
