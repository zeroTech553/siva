// Binary terminal frames (relay/PROTOCOL.md §Binary layout).
//
//   offset 0   1 byte   kind        0x01 = terminal
//   offset 1   16 bytes sessionId   UUID
//   offset 17  16 bytes clientId    UUID
//   offset 33  ...      sealed      nonce ‖ AES-GCM ciphertext
//
// Mirrors bridge/forge_frames.py. The relay routes on the 33-byte header
// without touching the sealed payload.

export const KIND_TERMINAL = 0x01
export const ROUTING_HEADER_BYTES = 33

export type TerminalFrame = {
  kind: number
  sessionId: string
  clientId: string
  sealed: Uint8Array
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export function bytesToUuid(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function packTerminal(sessionId: string, clientId: string, sealed: Uint8Array): Uint8Array {
  const frame = new Uint8Array(ROUTING_HEADER_BYTES + sealed.length)
  frame[0] = KIND_TERMINAL
  frame.set(uuidToBytes(sessionId), 1)
  frame.set(uuidToBytes(clientId), 17)
  frame.set(sealed, ROUTING_HEADER_BYTES)
  return frame
}

export function unpackTerminal(data: ArrayBuffer | Uint8Array): TerminalFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length < ROUTING_HEADER_BYTES || bytes[0] !== KIND_TERMINAL) return null
  return {
    kind: bytes[0],
    sessionId: bytesToUuid(bytes.subarray(1, 17)),
    clientId: bytesToUuid(bytes.subarray(17, 33)),
    sealed: bytes.subarray(ROUTING_HEADER_BYTES),
  }
}
