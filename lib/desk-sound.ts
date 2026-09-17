let audio: AudioContext | null = null
let songTimer = 0
let songNodes: AudioNode[] = []
let booted = false

function context() {
  if (typeof window === 'undefined') return null
  if (!audio) {
    const Ctor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audio = new Ctor()
  }
  return audio
}

function buzz(ctx: AudioContext, frequency: number, start: number, duration: number, gain = 0.05, type: OscillatorType = 'square') {
  const oscillator = ctx.createOscillator()
  const amp = ctx.createGain()
  oscillator.type = type
  oscillator.frequency.value = frequency
  amp.gain.setValueAtTime(0.0001, start)
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(amp)
  amp.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.02)
  return oscillator
}

export async function unlockDeskSound() {
  const ctx = context()
  if (!ctx) return
  if (ctx.state === 'suspended') await ctx.resume()
}

export async function playClick() {
  const ctx = context()
  if (!ctx) return
  await unlockDeskSound()
  buzz(ctx, 1400, ctx.currentTime, 0.035, 0.035, 'square')
}

export async function playBoot() {
  const ctx = context()
  if (!ctx || booted) return
  booted = true
  await unlockDeskSound()
  const now = ctx.currentTime
  buzz(ctx, 392, now, 0.18, 0.05, 'triangle')
  buzz(ctx, 523, now + 0.12, 0.2, 0.055, 'triangle')
  buzz(ctx, 659, now + 0.26, 0.28, 0.06, 'triangle')
  buzz(ctx, 784, now + 0.42, 0.42, 0.05, 'sine')
}

export async function playError() {
  const ctx = context()
  if (!ctx) return
  await unlockDeskSound()
  const now = ctx.currentTime
  buzz(ctx, 196, now, 0.16, 0.06)
  buzz(ctx, 165, now + 0.14, 0.22, 0.06)
}

export async function playDing() {
  const ctx = context()
  if (!ctx) return
  await unlockDeskSound()
  const now = ctx.currentTime
  buzz(ctx, 880, now, 0.12, 0.045, 'sine')
  buzz(ctx, 1320, now + 0.08, 0.18, 0.04, 'sine')
}

export async function playRecycle() {
  const ctx = context()
  if (!ctx) return
  await unlockDeskSound()
  const now = ctx.currentTime
  buzz(ctx, 660, now, 0.08, 0.04, 'triangle')
  buzz(ctx, 494, now + 0.07, 0.08, 0.04, 'triangle')
  buzz(ctx, 330, now + 0.14, 0.16, 0.045, 'triangle')
}

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
  const ctx = context()
  if (!ctx) return
  await unlockDeskSound()
  stopSong()
  const notes = SONG_NOTES[id]
  if (!notes) return

  const loop = () => {
    const now = ctx.currentTime
    for (const [freq, offset, duration] of notes) {
      const node = buzz(ctx, freq, now + offset, duration, 0.035, 'triangle')
      songNodes.push(node)
    }
    const length = notes.reduce((max, note) => Math.max(max, note[1] + note[2]), 0)
    songTimer = window.setTimeout(loop, Math.round((length + 0.35) * 1000))
  }
  loop()
}
