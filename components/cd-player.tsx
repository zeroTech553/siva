'use client'

import { useState } from 'react'
import { DESK_SONGS, playDing, playSong, stopSong } from '@/lib/desk-sound'
import { Win95Button } from '@/components/win95'

export function CdPlayer() {
  const [current, setCurrent] = useState<string>(DESK_SONGS[0].id)
  const [playing, setPlaying] = useState(false)
  const track = DESK_SONGS.find((song) => song.id === current) || DESK_SONGS[0]

  return (
    <div className="cd-player">
      <p className="cd-disc">{playing ? 'PLAY' : 'STOP'} — {track.name}</p>
      <label>
        Track
        <select
          value={current}
          onChange={(event) => {
            const next = event.target.value
            setCurrent(next)
            if (playing) void playSong(next)
          }}
        >
          {DESK_SONGS.map((song) => (
            <option key={song.id} value={song.id}>
              {song.name}
            </option>
          ))}
        </select>
      </label>
      <div className="cd-actions">
        <Win95Button
          onClick={() => {
            void playSong(current)
            setPlaying(true)
            void playDing()
          }}
        >
          Play
        </Win95Button>
        <Win95Button
          onClick={() => {
            stopSong()
            setPlaying(false)
          }}
        >
          Stop
        </Win95Button>
      </div>
    </div>
  )
}
