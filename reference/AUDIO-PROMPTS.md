# Dunk the Break — audio plan and generation prompts

Everything the game plays, what triggers it, and a prompt to generate each file. Drop the files into `assets/audio/` with these exact names and the game picks them up; while a file is missing, the current synthesised tone plays instead. Formats: **MP3 at 192 kbps** for music, **WAV 44.1 kHz 16-bit** for effects (short effects must start instantly, so no leading silence and no fade-in). Keep effects under 1 second unless stated. Loudness: music at about -16 LUFS, effects peaking at -3 dBFS.

Use any generator you like (Suno, Udio, ElevenLabs sound effects, Stable Audio). The prompts are written to paste as they are.

## Music

| File | When it plays | Prompt |
| --- | --- | --- |
| `music-attract.mp3` (loop, 60 s) | Cover screen | Warm, premium lounge groove at 92 BPM, soft brushed drums, muted electric piano, a gentle marimba melody, light vinyl warmth, upbeat but relaxed, café break mood, no vocals, seamless loop, 60 seconds. |
| `music-register.mp3` (loop, 45 s) | Register and verify screens | The same lounge palette as the attract track but calmer and quieter, piano and soft pad only, 80 BPM, no drums, unobtrusive, seamless loop, 45 seconds. |
| `music-play.mp3` (loop, 45 s) | Gameplay, first 30 s | Energetic, bright arcade pop at 128 BPM, punchy kick, clap on 2 and 4, plucky synth arpeggio, bright brass stabs, playful and premium, no vocals, builds energy without getting harsh, seamless loop, 45 seconds. |
| `music-play-fast.mp3` (loop, 20 s) | Gameplay, final 10 s | The same track as music-play, same key, pitched and sped to 148 BPM with a driving hi-hat, rising tension, seamless loop, 20 seconds. |
| `music-win.mp3` (one-shot, 8 s) | Results, prize won | Triumphant 8-second fanfare in the same key, brass, sparkle glissando, warm timpani hit, ends cleanly. |
| `music-lose.mp3` (one-shot, 5 s) | Results, no prize | Warm, encouraging 5-second sting in the same key, rising at the end, friendly, not sad. |

The game crossfades between the loops in 0.6 s, so the loops must be in the same key and the fast track should be the play track's double-time version.

## Effects

| File | Trigger | Prompt |
| --- | --- | --- |
| `sfx-ui-tap.wav` | Any button or key press | Soft, premium UI tap, short wooden click with a tiny warm resonance, 80 ms. |
| `sfx-ui-done.wav` | DONE on the keyboard, field complete | Gentle two-note confirmation chime, marimba, rising, 300 ms. |
| `sfx-ui-error.wav` | Validation error | Soft double "bonk", muted, friendly, not harsh, 250 ms. |
| `sfx-detect.wav` | Mug detected on Show Your Mug | Bright, satisfying lock-on: a soft whoosh into a crisp two-tone chime, 500 ms. |
| `sfx-count.wav` | Countdown 3, 2, 1 | Clean, deep tick with a short tail, 150 ms. |
| `sfx-go.wav` | GO! | Short energetic brass hit with a cymbal splash, 600 ms. |
| `sfx-catch.wav` | Wafer caught (+1) | Juicy chocolate plop: a soft liquid splash with a bright pop on top, satisfying, 250 ms. |
| `sfx-catch-2.wav`, `sfx-catch-3.wav` | Alternates on consecutive catches | Two variations of the catch sound, same character, slightly higher in pitch each time. |
| `sfx-crunch.wav` | Layered under every catch, 70 ms after the plop | Crisp wafer crunch: a dry snap into a burst of tiny crackles, bright, 220 ms. |
| `sfx-gold.wav` | Gold wafer caught (+3) | Sparkling magical chime, rising arpeggio with shimmer, premium, 700 ms. |
| `sfx-streak.wav` | 3 in a row | Quick ascending four-note fanfare, bright bells, 600 ms. |
| `sfx-hit.wav` | Hazard caught (−1) | Dull thud with a short glass crack and a low buzz, comic not scary, 400 ms. |
| `sfx-miss.wav` | Wafer missed | Very soft, low "whiff", barely there, 200 ms. |
| `sfx-whoosh.wav` | Crossfire pattern starts | Fast airy whoosh passing left to right, 400 ms. |
| `sfx-hurry.wav` | 10 seconds left | Three quick urgent beeps rising in pitch, 500 ms. |
| `sfx-timeup.wav` | Time's up | Deep gong with a short shimmer, 1.2 s. |
| `sfx-countup.wav` | Score counting up on results | Rapid soft ticker ticks, loopable, 1 s. |
| `sfx-prize.wav` | Prize card appears | Warm reveal: a soft whoosh into a bright sparkle, 800 ms. |
| `sfx-confetti.wav` | Confetti burst (if enabled) | Party popper pop with fluttering paper, 700 ms. |
| `amb-steam.wav` (loop, 10 s) | Cover and results, very quiet | Gentle steam hiss and the faintest café room tone, seamless loop. |

## Mixing rules the game applies

- Music ducks by 6 dB for 300 ms under catch, gold and streak sounds, so the effects always cut through.
- Catch sounds rotate through the three variations and pitch up slightly with the streak, so a run of catches feels like it builds.
- The kiosk volume is controlled in the staff setup panel: music and effects on separate sliders, master mute.

## What to tell the generator if it struggles

If a generator ignores the loop instruction, ask for "no intro, no outro, constant energy, ends on the downbeat" and I will trim the loop point. If an effect comes back with a fade-in, ask for "transient at the very start, no fade-in".
