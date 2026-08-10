@echo off
chcp 65001 >nul
COLOR 0A
TITLE 【監視】kohai.txt
powershell -Command "while($true){ Clear-Host; Get-Content kohai.txt -Encoding UTF8; Start-Sleep -Seconds 1 }"