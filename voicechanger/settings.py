import json
import pyaudio
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path

# See voice_changer.py's Config for the program/data split rationale.
_PROGRAM_DIR = Path(__file__).resolve().parent
_DATA_DIR = _PROGRAM_DIR.parent / "local_data" / "voicechanger"
_DATA_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = _DATA_DIR / 'device_settings.json'

# Load the available devices
def list_devices():
    """List all available audio devices (input and output)."""
    p = pyaudio.PyAudio()
    device_list = []
    for i in range(p.get_device_count()):
        device = p.get_device_info_by_index(i)
        # Skip devices with zero input and output
        if device['maxInputChannels'] == 0 and device['maxOutputChannels'] == 0:
            continue
        device_list.append((i, device['name'], device['maxInputChannels'], device['maxOutputChannels']))
    p.terminate()
    return device_list

# Save settings to a JSON file
def save_settings(settings):
    with open(SETTINGS_FILE, 'w') as f:
        json.dump(settings, f, indent=4)

# Load settings from a JSON file
def load_settings():
    try:
        with open(SETTINGS_FILE, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        return {
            "voice_speaker_keyword": "",
            "notification_speaker_keyword": ""
        }

# GUI for selecting devices
def show_device_selector():
    def apply_and_save():
        """Save the selected display names to settings and close the window."""
        voice_speaker_name = voice_speaker_combobox.get()
        notification_speaker_name = notification_speaker_combobox.get()

        settings = {
            "voice_speaker_keyword": voice_speaker_name,
            "notification_speaker_keyword": notification_speaker_name
        }

        save_settings(settings)
        messagebox.showinfo("成功", "デバイスの設定が保存されました。")
        root.quit()

    device_list = list_devices()
    settings = load_settings()

    voice_speaker_options = []
    notification_speaker_options = []

    # Map from display_name → index
    display_name_to_index = {}

    for index, name, input_ch, output_ch in device_list:
        display_name = f"{name}"
        display_name_to_index[display_name] = index

        if output_ch > 0:
            voice_speaker_options.append(display_name)
            notification_speaker_options.append(display_name)

    # Create the GUI window
    root = tk.Tk()
    root.title("マイクとスピーカー設定")
    root.geometry("550x300")

    # Speaker 1 combobox
    tk.Label(root, text="🔊音声スピーカー:").pack(pady=5)
    voice_speaker_combobox = ttk.Combobox(root, values=voice_speaker_options, width=60)
    voice_speaker_combobox.pack(pady=5)
    voice_speaker_combobox.set(settings.get("voice_speaker_keyword", ""))

    # Speaker 2 combobox
    tk.Label(root, text="🔔通知音用スピーカー:").pack(pady=5)
    notification_speaker_combobox = ttk.Combobox(root, values=notification_speaker_options, width=60)
    notification_speaker_combobox.pack(pady=5)
    notification_speaker_combobox.set(settings.get("notification_speaker_keyword", ""))

    # Apply and Save button
    apply_button = tk.Button(root, text="保存", command=apply_and_save)
    apply_button.pack(pady=20)

    root.mainloop()

    return display_name_to_index

# Get device index from saved display name
def get_selected_device_indices(device_map, settings):
    voice_index = device_map.get(settings.get("voice_speaker_keyword"))
    notification_index = device_map.get(settings.get("notification_speaker_keyword"))

    return voice_index, notification_index

if __name__ == "__main__":
    # Show the device selector UI and get the mapping
    display_name_to_index = show_device_selector()

    # Load settings after GUI is closed
    settings = load_settings()
    voice_index, notification_index = get_selected_device_indices(display_name_to_index, settings)

    # Show results

    if voice_index is None:
        print(f"選択された音声スピーカーが見つかりません：{settings.get('voice_speaker_keyword')}")
    else:
        print(f"選択された音声スピーカー: {voice_index} - {settings.get('voice_speaker_keyword')}")

    if notification_index is None:
        print(f"選択された通知スピーカーが見つかりません：{settings.get('notification_speaker_keyword')}")
    else:
        print(f"選択された通知スピーカー: {notification_index} - {settings.get('notification_speaker_keyword')}")
