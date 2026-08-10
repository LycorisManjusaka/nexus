@echo off
chcp 65001 >nul
COLOR 0B
TITLE 【監視】kohai.txt
powershell -Command "while($true){ Clear-Host; Get-Content ear_log.txt -Encoding UTF8; Start-Sleep -Seconds 1 }"