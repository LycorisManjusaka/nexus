import requests
import json
import os
import urllib.parse

# VoiceVox engine settings
VOICEVOX_ENGINE_URL = "http://127.0.0.1:50021"  # Adjust if your VoiceVox engine runs on a different port

def text_to_speech(text, speaker):
    """Convert text to speech using the VoiceVox engine and save as WAV file."""
    # Generate the filename based on the text and speaker ID
    filename_safe_text = text  # URL-safe version of the text
    output_path = f"{filename_safe_text}_{speaker}.wav"

    # Check if the audio file already exists
    if os.path.exists(output_path):
        print(f"Audio file '{output_path}' already exists. Skipping...")
        return output_path  # Return the existing file path
    
    try:
        # Step 1: Synthesize audio query
        print(f"Sending audio query to VoiceVox engine for text: {text}")
        query_payload = {
            "text": text,
            "speaker": speaker
        }
        
        # Request audio query
        query_response = requests.post(f"{VOICEVOX_ENGINE_URL}/audio_query", params=query_payload)
        
        if query_response.status_code != 200:
            print(f"Error generating audio query: {query_response.status_code} - {query_response.text}")
            return None
        
        audio_query = query_response.json()
        print("Audio query successfully received from the engine.")
        
        # Step 2: Generate speech audio from the audio query
        print("Requesting speech synthesis from the VoiceVox engine...")
        synthesis_response = requests.post(
            f"{VOICEVOX_ENGINE_URL}/synthesis", 
            params={"speaker": speaker},
            data=json.dumps(audio_query),
            headers={"Content-Type": "application/json"}
        )
        
        if synthesis_response.status_code != 200:
            print(f"Error during synthesis: {synthesis_response.status_code} - {synthesis_response.text}")
            return None

        # Save the audio file to the specified output path
        with open(output_path, "wb") as audio_file:
            audio_file.write(synthesis_response.content)
        
        print(f"Audio has been successfully saved to {output_path}")
        return output_path
    
    except requests.exceptions.RequestException as e:
        print(f"Network error when communicating with VoiceVox engine: {e}")
        return None

def generate_phrases_and_audio():
    """Generate 30 phrases and save them as audio files with changing VOICE_IDs."""
    for index in range(30, 100):  # Loop from 1 to 30 for character index
        phrase = f"こんにちは！私は{index}番目のキャラです。どう、かわいい？"
        voice_id = index  # Change VOICE_ID (you can adjust the logic for your needs)
        
        # Generate audio for the phrase
        text_to_speech(phrase, speaker=voice_id)

if __name__ == "__main__":
    # Step 3: Generate phrases and audio files
    generate_phrases_and_audio()
