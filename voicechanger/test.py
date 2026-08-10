import json
import time
import wave
import pyaudio
import os

SETTINGS_FILE = "device_settings.json"

NOTIFICATIONS = {
    "test1": os.path.join("notifications", "test1.wav"),
    "test2": os.path.join("notifications", "test2.wav")
}

def load_settings():
    print("デバイスの設定を読み込む...")
    with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
        settings = json.load(f)
    print(f"ロードされた設定: {settings}")
    return settings

def list_devices():
    print("オーディオ出力デバイスのリスト...")
    p = pyaudio.PyAudio()
    device_list = []
    for i in range(p.get_device_count()):
        info = p.get_device_info_by_index(i)
        device_list.append((i, info['name'], info['maxOutputChannels']))
        print(f"Found device {i}: {info['name']} (Outputs: {info['maxOutputChannels']})")
    p.terminate()
    return device_list

def select_device_by_keyword(device_list, keyword):
    print(f"Searching for device with keyword: '{keyword}'")
    keyword = keyword.lower()
    for index, name, outputs in device_list:
        if keyword in name.lower() and outputs > 0:
            print(f"Matched device: {name} (Index: {index})")
            return index
    print("No matching device found.")
    return None

def play_sound(wav_path, device_index, label):
    try:
        with wave.open(wav_path, 'rb') as wf:
            print(f"[{label}] Opened WAV file: {wav_path}")
            p = pyaudio.PyAudio()
            stream = p.open(format=p.get_format_from_width(wf.getsampwidth()),
                            channels=wf.getnchannels(),
                            rate=wf.getframerate(),
                            output=True,
                            output_device_index=device_index)
            data = wf.readframes(1024)
            while data:
                stream.write(data)
                data = wf.readframes(1024)
            stream.stop_stream()
            stream.close()
            p.terminate()
            print(f"[{label}] Finished playback.")
    except Exception as e:
        print(f"[{label}] Error playing sound: {e}")

if __name__ == "__main__":
    try:
        settings = load_settings()
        devices = list_devices()

        voice_speaker_index = select_device_by_keyword(devices, settings["voice_speaker_keyword"])
        notification_speaker_index = select_device_by_keyword(devices, settings["notification_speaker_keyword"])

        if voice_speaker_index is None or notification_speaker_index is None:
            print("エラー： 1つまたは両方の出力デバイスが見つかりません。終了します。")
            exit(1)

        if not os.path.exists(NOTIFICATIONS["test1"]):
            print(f"Error: '{NOTIFICATIONS['test1']}' not found.")
            exit(1)
        if not os.path.exists(NOTIFICATIONS["test2"]):
            print(f"Error: '{NOTIFICATIONS['test2']}' not found.")
            exit(1)

        print("ープ再生開始")
        while True:
            play_sound(NOTIFICATIONS["test1"], voice_speaker_index, "test1")
            time.sleep(1)
            play_sound(NOTIFICATIONS["test2"], notification_speaker_index, "test2")
            time.sleep(1)

    except Exception as e:
        print(f"予期せぬエラー： {e}")
