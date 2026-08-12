import asyncio
import websockets
import time
import re
from pathlib import Path

import nexus_identity

# ==========================================
# 設定・定数クラス
# ==========================================
class Config:
    PORT = 13001
    # See voice_changer.py's Config for the program/data split rationale.
    PROGRAM_DIR = Path(__file__).resolve().parent
    DATA_DIR = PROGRAM_DIR.parent / "local_data" / "voicechanger"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE = DATA_DIR / "ear_log.txt"

class EarService:
    def __init__(self):
        # 完全に無視するポンコツAIの幻覚リスト
        self.noise_hallucinations = {"ごめん", "ありがとうございました", "ご視野", "ご視野の", "ん"}

    def process_text(self, text):
        text = text.strip()
        if not text:
            return None
        
        # 末尾の句読点を無視して純粋なテキストを抽出
        clean_text = re.sub(r'[。！？\s]+$', '', text)
        
        # 完全に一致した場合は None を返し、ログ記録を完全にスキップ（無視）する
        if clean_text in self.noise_hallucinations:
            return None
            
        return text

    async def handle_websocket(self, websocket):
        print(f"[Ear Service] 接続確立: {websocket.remote_address} (第2のWhisperとリンクしました)")
        try:
            async for message in websocket:
                processed_msg = self.process_text(message)
                
                # processed_msg が None の場合は何もせず次のメッセージを待つ
                if processed_msg:
                    timestamp = time.strftime('%H:%M:%S')
                    log_line = f"[{timestamp}] (人) {processed_msg}\n"
                    
                    with open(Config.LOG_FILE, 'a', encoding='utf-8') as f:
                        f.write(log_line)
                    
                    print(f"   [Ear Log] {log_line.strip()}")
                    
        except websockets.exceptions.ConnectionClosed:
            print(f"[Ear Service] 切断: {websocket.remote_address}")
        except Exception as e:
            print(f"[Ear Service] エラー発生: {e}")

    async def start(self):
        print("=========================================")
        print("  Sempai's Ear Service (聴覚ロガー)")
        print(f"  Port: {Config.PORT}")
        print(f"  Log File: {Config.LOG_FILE.absolute()}")
        print("=========================================")
        print("第2の『ゆーかねすぴれこ』を起動し、送信先を ws://127.0.0.1:13001 に設定してください。")
        
        async with websockets.serve(self.handle_websocket, "127.0.0.1", Config.PORT):
            await asyncio.Future()

if __name__ == "__main__":
    service = EarService()
    try:
        asyncio.run(service.start())
    except KeyboardInterrupt:
        print("\n[Ear Service] 監視を停止しました。")