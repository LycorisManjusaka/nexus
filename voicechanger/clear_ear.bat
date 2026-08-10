@echo off
COLOR 08
TITLE 【初期化】ログファイルのパージ
echo ログを0バイトに初期化しています...

type nul > ear_log.txt

echo 完了しました。このウィンドウは2秒後に自動で閉じます。
timeout /t 2 > nul