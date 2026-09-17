let audio: AudioContext | null = null
let started = false

function context() {
  if (typeof window === 'undefined') return null
  if (!audio) {
    const Ctor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audio = new Ctor()
  }
  return audio
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number, gain = 0.05) {
  const oscillator = ctx.createOscillator()
  const amp = ctx.createGain()
  oscillator.type = 'square'
  oscillator.frequency.value = frequency
  amp.gain.setValueAtTime(0.0001, start)
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.02)
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(amp)
  amp.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.02)
}

export async function unlockDeskSound() {
  const ctx = context()
  if (!ctx) return
  if (ctx.state === 'suspended') await ctx.resume()
}

export async function playBootJingle() {
  const ctx = context()
  if (!ctx || started) return
  started = true
  await unlockDeskSound()
  const now = ctx.currentTime
  tone(ctx, 196, now, 0.12, 0.04)
  tone(ctx, 262, now + 0.12, 0.12, 0.045)
  tone(ctx, 330, now + 0.24, 0.14, 0.05)
  tone(ctx, 392, now + 0.38, 0.28, 0.06)
}

export async function playClick() {
  const ctx = context()
  if (!ctx) return
  await unlockDeskSound()
  tone(ctx, 880, ctx.currentTime, 0.04, 0.03)
}

export async function playErrorBeep() {
  const ctx = context()
  if (!ctx) return
  await unlockDeskSound()
  tone(ctx, 220, ctx.currentTime, 0.16, 0.05)
}
