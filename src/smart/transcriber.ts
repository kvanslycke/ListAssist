// Transcriber contract. Implementations: whisperTranscriber (default,
// local whisper.cpp server) and gemmaTranscriber (experimental, uses
// Gemma's native audio via Ollama's OpenAI-compatible endpoint).

export interface Transcriber {
  name: string;
  transcribe(wav: ArrayBuffer): Promise<string>;
}

export class TranscriberError extends Error {
  constructor(public readonly transcriber: string, cause: unknown) {
    super(`${transcriber} transcription failed: ${(cause as Error).message ?? cause}`);
    this.name = "TranscriberError";
  }
}
