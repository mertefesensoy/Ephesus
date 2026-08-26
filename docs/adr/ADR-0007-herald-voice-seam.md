# ADR-0007 — The Herald: provider-agnostic voice seam; ElevenLabs primary, OpenAI Realtime fallback

**Status:** accepted · **Date:** 2026-08-26

## Context
The Architect wants a Jarvis-style spoken chief of staff: briefings aloud, conversation
with Artemis, meeting narration, voice approvals. Voice providers differ wildly in API
shape (streamed TTS + separate STT vs full-duplex speech-to-speech), pricing, and
availability — and the Architect explicitly chose ElevenLabs quality with OpenAI
Realtime as the fallback. Voice must also never be a hard dependency (FR-8.6).

## Decision
A **provider-agnostic seam** in the main process with three capability interfaces —
`SpeechToText` (streaming transcription + endpointing), `TextToSpeech` (streamed audio
with cancel), and optional `DuplexVoice` (speech-to-speech session) — plus a
**conversation policy layer** above them owning wake word, push-to-talk, barge-in,
repeat-back confirmation, and provider selection.

- **ElevenLabs adapter** is the reference implementation (TTS streaming + their
  conversational/STT APIs), chosen for voice quality and latency.
- **OpenAI Realtime adapter** implements `DuplexVoice`; the policy layer maps the
  common conversation contract onto it.
- **Automatic failover**: on provider error, auth failure, or sustained latency breach
  the policy layer switches providers mid-session within 3 s (NFR-3), announces the
  switch in one line, and keeps the transcript continuous. Failback is manual.
- **Local engines** (Piper/Kokoro for TTS, whisper.cpp for STT) are future adapters
  behind the same interfaces; nothing outside the seam may reference a provider SDK
  (enforced by lint rule + conformance tests, NFR-12).
- **Barge-in is sacred:** Architect audio input stops TTS playback within 250 ms
  regardless of provider; the interrupted sentence is retained in the transcript.
- **Persona is data:** the Herald's voice id, style prompt, and phrase book live in
  config. The persona is a composed, understated British-styled assistant — an homage
  *style*; we do not clone any actor's voice or use any studio's character name.

## Options considered
- **ElevenLabs only.** Best quality, but a single external dependency between the
  Architect and their company's mouth; an outage silences the product.
- **OpenAI Realtime only.** Simplest full-duplex integration, weaker control over the
  specific voice character the Architect wants.
- **Local only.** Private and free but a quality step down; wrong default for a
  "best voice available" requirement — kept as the privacy option, not the default.

## Consequences
- Two providers must be carried through testing (the conformance suite runs against
  recorded fixtures; live smoke tests are opt-in with keys).
- The policy layer is where all safety-relevant voice behavior lives (repeat-back for
  destructive approvals, FR-8.4) — provider adapters stay dumb pipes.
- Voice state is never authoritative: every voice interaction round-trips through the
  same Artemis/Hermes/gate machinery as text; the Herald is an I/O modality, not a
  control path.
