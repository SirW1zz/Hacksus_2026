"""
Deepgram service for real-time speech-to-text with speaker diarization.
"""

import json
import asyncio
from typing import Callable, Optional
from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions
from config import settings


class DeepgramTranscriber:
    """Manages a live Deepgram transcription session with speaker diarization."""

    def __init__(self, on_transcript: Optional[Callable] = None):
        self.client = DeepgramClient(settings.deepgram_api_key)
        self.connection = None
        self.on_transcript = on_transcript  # callback(speaker, text, is_final)
        self._is_running = False

    async def start(self):
        """Start a live transcription session."""
        self.connection = self.client.listen.asynclive.v("1")

        # Register event handlers
        self.connection.on(LiveTranscriptionEvents.Transcript, self._handle_transcript)
        self.connection.on(LiveTranscriptionEvents.Error, self._handle_error)

        options = LiveOptions(
            model="nova-2",
            language="en",
            smart_format=True,
            diarize=True,           # Speaker diarization
            punctuate=True,
            interim_results=True,
            utterance_end_ms=1500,
            vad_events=True,
            encoding="linear16",
            sample_rate=16000,
            channels=1,
        )

        if await self.connection.start(options):
            self._is_running = True
            return True
        return False

    async def send_audio(self, audio_data: bytes):
        """Send raw audio bytes to Deepgram for transcription."""
        if self.connection and self._is_running:
            await self.connection.send(audio_data)

    async def stop(self):
        """Stop the transcription session."""
        self._is_running = False
        if self.connection:
            await self.connection.finish()

    async def _handle_transcript(self, _client, result, **kwargs):
        """Process incoming transcript results."""
        try:
            sentence = result.channel.alternatives[0]
            transcript = sentence.transcript
            if not transcript:
                return

            is_final = result.is_final

            # Extract speaker from diarization
            speaker = "Unknown"
            if sentence.words and len(sentence.words) > 0:
                speaker_id = sentence.words[0].speaker
                speaker = f"Speaker {speaker_id}" if speaker_id is not None else "Unknown"

            if self.on_transcript:
                await self.on_transcript(speaker, transcript, is_final)

        except Exception as e:
            print(f"[Deepgram] Transcript handling error: {e}")

    async def _handle_error(self, _client, error, **kwargs):
        """Handle transcription errors."""
        print(f"[Deepgram] Error: {error}")

    @property
    def is_running(self):
        return self._is_running


async def transcribe_audio_file(audio_bytes: bytes) -> dict:
    """One-shot transcription of an audio file (for post-processing)."""
    client = DeepgramClient(settings.deepgram_api_key)

    source = {"buffer": audio_bytes, "mimetype": "audio/wav"}
    options = {
        "model": "nova-2",
        "language": "en",
        "smart_format": True,
        "diarize": True,
        "punctuate": True,
    }

    response = await client.listen.asyncrest.v("1").transcribe_file(source, options)
    return response.to_dict()
