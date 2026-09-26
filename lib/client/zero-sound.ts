'use client'

/**
 * lib/client/zero-sound.ts — every sound the machine makes, in one place.
 *
 * All of it is synthesised with WebAudio (no audio files to download), which is
 * why it is free on the Vercel free tier and instant on a phone. Nothing plays
 * until the visitor has interacted with the page: browsers block audio before
 * the first gesture, and `unlockZeroSound()` is what lifts that block.
 *
 * Mute + volume are persisted, and the machine's speaker button is the only UI
 * for them (`components/computer/hardware/machine-shell.tsx`).
 */

let audio: AudioContext | null = null
let songTimer = 0
let songNodes: AudioNode[] = []
let muted = false
let volume = 1
let bootPlayed = false

export const SOUND_PREFS_KEY = 'zero.sound.v1'

type SoundPrefs = { muted?: boolean; volume?: number }

export function readSoundPrefs(): SoundPrefs {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(SOUND_PREFS_KEY) || '{}') as SoundPrefs
  } catch {
    return {}
  }
}

export function writeSoundPrefs(prefs: SoundPrefs) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SOUND_PREFS_KEY, JSON.stringify({ ...readSoundPrefs(), ...prefs }))
}

export function applySoundPrefs() {
  const prefs = readSoundPrefs()
  muted = Boolean(prefs.muted)
  volume = typeof prefs.volume === 'number' ? Math.min(Math.max(prefs.volume, 0), 1) : 1
  return { muted, volume }
}

export function setMuted(next: boolean) {
  muted = next
  writeSoundPrefs({ muted: next })
  if (next) stopSong()
}

export function isMuted() {
  return muted
}

export function setVolume(next: number) {
  volume = Math.min(Math.max(next, 0), 1)
  writeSoundPrefs({ volume })
}

export function getVolume() {
  return volume
}

function context() {
  if (typeof window === 'undefined') return null
  if (!audio) {
    const Ctor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audio = new Ctor()
  }
  return audio
}

function buzz(
  ctx: AudioContext,
  frequency: number,
  start: number,
  duration: number,
  gain = 0.05,
  type: OscillatorType = 'square',
) {
  if (muted || gain <= 0) return null
  const oscillator = ctx.createOscillator()
  const amp = ctx.createGain()
  const scaled = gain * volume
  oscillator.type = type
  oscillator.frequency.value = frequency
  amp.gain.setValueAtTime(0.0001, start)
  amp.gain.exponentialRampToValueAtTime(scaled, start + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(amp)
  amp.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.02)
  return oscillator
}

async function ready(): Promise<AudioContext | null> {
  const ctx = context()
  if (!ctx) return null
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return null
    }
  }
  return ctx
}

export async function unlockZeroSound() {
  await ready()
}

/** One key press on the physical keyboard: a short, quiet mechanical tick. */
export async function playKey() {
  const ctx = await ready()
  if (!ctx) return
  buzz(ctx, 2100, ctx.currentTime, 0.018, 0.018, 'square')
  buzz(ctx, 320, ctx.currentTime, 0.03, 0.022, 'triangle')
}

/** A UI click: mouse button, window button, taskbar button. */
export async function playClick() {
  const ctx = await ready()
  if (!ctx) return
  buzz(ctx, 1400, ctx.currentTime, 0.035, 0.032, 'square')
}

export async function playWindowOpen() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 523, now, 0.05, 0.03, 'triangle')
  buzz(ctx, 784, now + 0.04, 0.07, 0.028, 'triangle')
}

export async function playWindowClose() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 659, now, 0.05, 0.028, 'triangle')
  buzz(ctx, 392, now + 0.04, 0.07, 0.03, 'triangle')
}

export async function playMinimize() {
  const ctx = await ready()
  if (!ctx) return
  buzz(ctx, 880, ctx.currentTime, 0.05, 0.024, 'sine')
  buzz(ctx, 440, ctx.currentTime + 0.04, 0.07, 0.024, 'sine')
}

/** Power switch: a low thunk with a relay click on top. */
export async function playPower() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 90, now, 0.16, 0.05, 'sine')
  buzz(ctx, 220, now + 0.08, 0.1, 0.035, 'square')
}

/** The Zero OS startup chime — once per power-on. */
export async function playBoot() {
  const ctx = await ready()
  if (!ctx || bootPlayed) return
  bootPlayed = true
  const now = ctx.currentTime
  buzz(ctx, 392, now, 0.18, 0.05, 'triangle')
  buzz(ctx, 523, now + 0.12, 0.2, 0.05, 'triangle')
  buzz(ctx, 659, now + 0.26, 0.28, 0.055, 'triangle')
  buzz(ctx, 988, now + 0.42, 0.5, 0.045, 'sine')
}

export function resetBootChime() {
  bootPlayed = false
}

export async function playShutdown() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 659, now, 0.16, 0.045, 'sine')
  buzz(ctx, 494, now + 0.14, 0.18, 0.045, 'sine')
  buzz(ctx, 330, now + 0.3, 0.24, 0.045, 'sine')
  buzz(ctx, 196, now + 0.5, 0.34, 0.04, 'sine')
}

/** Drive activity: CD tray, floppy, hard-disk seek. */
export async function playDisk() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 180, now, 0.07, 0.04, 'square')
  buzz(ctx, 120, now + 0.08, 0.12, 0.035, 'square')
  buzz(ctx, 90, now + 0.16, 0.08, 0.028, 'triangle')
}

export async function playDing() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 880, now, 0.12, 0.04, 'sine')
  buzz(ctx, 1320, now + 0.08, 0.18, 0.035, 'sine')
}

export async function playError() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 196, now, 0.16, 0.055)
  buzz(ctx, 165, now + 0.14, 0.22, 0.055)
}

export async function playRecycle() {
  const ctx = await ready()
  if (!ctx) return
  const now = ctx.currentTime
  buzz(ctx, 660, now, 0.08, 0.035, 'triangle')
  buzz(ctx, 494, now + 0.07, 0.08, 0.035, 'triangle')
  buzz(ctx, 330, now + 0.14, 0.16, 0.04, 'triangle')
}

export async function playTypewriter(text: string) {
  if (muted) return
  for (let index = 0; index < Math.min(text.length, 6); index += 1) {
    window.setTimeout(() => void playKey(), index * 28)
  }
}

/* ------------------------------------------------------------------ *
 * CD Player: four short looping melodies synthesised from note tables.
 * ------------------------------------------------------------------ */

export const DESK_SONGS = [
  { id: 'clouds', name: 'Clouds.mid' },
  { id: 'mines', name: 'Mines.mid' },
  { id: 'solitaire', name: 'Solitaire.mid' },
  { id: 'canyon', name: 'Canyon.mid' },
] as const

const SONG_NOTES: Record<string, Array<[number, number, number]>> = {
  clouds: [
    [392, 0, 0.35],
    [494, 0.35, 0.35],
    [587, 0.7, 0.5],
    [523, 1.2, 0.35],
    [440, 1.55, 0.45],
    [392, 2.05, 0.6],
  ],
  mines: [
    [659, 0, 0.12],
    [784, 0.12, 0.12],
    [880, 0.24, 0.12],
    [784, 0.36, 0.12],
    [659, 0.48, 0.18],
    [523, 0.7, 0.22],
    [587, 0.96, 0.18],
    [659, 1.18, 0.3],
  ],
  solitaire: [
    [330, 0, 0.28],
    [392, 0.28, 0.28],
    [494, 0.56, 0.42],
    [440, 1.02, 0.28],
    [392, 1.3, 0.28],
    [330, 1.58, 0.5],
  ],
  canyon: [
    [262, 0, 0.22],
    [330, 0.22, 0.22],
    [392, 0.44, 0.22],
    [523, 0.66, 0.4],
    [392, 1.1, 0.22],
    [330, 1.32, 0.22],
    [294, 1.54, 0.4],
  ],
}

export function stopSong() {
  if (songTimer) {
    window.clearTimeout(songTimer)
    songTimer = 0
  }
  for (const node of songNodes) {
    try {
      node.disconnect()
    } catch {
      // already stopped
    }
  }
  songNodes = []
}

export async function playSong(id: string) {
  const ctx = await ready()
  if (!ctx) return
  stopSong()
  const notes = SONG_NOTES[id]
  if (!notes) return

  const loop = () => {
    const now = ctx.currentTime
    for (const [freq, offset, duration] of notes) {
      const node = buzz(ctx, freq, now + offset, duration, 0.03, 'triangle')
      if (node) songNodes.push(node)
    }
    const length = notes.reduce((max, note) => Math.max(max, note[1] + note[2]), 0)
    songTimer = window.setTimeout(loop, Math.round((length + 0.35) * 1000))
  }
  loop()
}
