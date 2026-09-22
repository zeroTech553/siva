// Browser side of the end-to-end channel (relay/PROTOCOL.md §Encryption).
//
// Mirrors bridge/forge_crypto.py exactly:
//
//   key   = HKDF-SHA256(X25519(secret, devicePub),
//                       salt = SHA256(deviceId),
//                       info = "forge-e2e-v2:" + deviceId + ":" + clientId)
//   nonce = 4-byte direction salt ‖ 8-byte big-endian counter
//   frame = nonce ‖ AES-256-GCM(plaintext)
//
// Each direction has its own salt and counter, so nonces never collide and a
// replayed or reordered frame fails to decrypt. The relay only ever sees
// public keys and ciphertext. Interop with the Python bridge is pinned by
// bridge/tests/test_crypto_interop.py.

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const HKDF_INFO_PREFIX = 'forge-e2e-v2'
const NONCE_BYTES = 12
const SALT_BYTES = 4

const utf8 = (text: string) => new TextEncoder().encode(text)

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Thrown when a frame fails to authenticate or arrives out of order. */
export class ChannelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelError'
  }
}

export class TerminalChannel {
  private readonly secret: Uint8Array
  readonly publicKey: Uint8Array
  readonly sendSalt: Uint8Array
  private deviceSalt: Uint8Array | null = null
  private key: CryptoKey | null = null
  private sendCounter = 0
  private recvCounter = 0

  constructor() {
    this.secret = x25519.utils.randomSecretKey()
    this.publicKey = x25519.getPublicKey(this.secret)
    this.sendSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  }

  get ready(): boolean {
    return this.key !== null
  }

  /** Complete the handshake with the laptop's `term_key` reply. */
  async finish(
    deviceId: string,
    clientId: string,
    devicePubBase64: string,
    deviceSaltBase64: string,
  ): Promise<void> {
    const shared = x25519.getSharedSecret(this.secret, fromBase64(devicePubBase64))
    const raw = hkdf(
      sha256,
      shared,
      sha256(utf8(deviceId)),
      utf8(`${HKDF_INFO_PREFIX}:${deviceId}:${clientId}`),
      32,
    )
    this.key = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ])
    this.deviceSalt = fromBase64(deviceSaltBase64)
    this.sendCounter = 0
    this.recvCounter = 0
  }

  private nonce(salt: Uint8Array, counter: number): Uint8Array {
    const out = new Uint8Array(NONCE_BYTES)
    out.set(salt.subarray(0, SALT_BYTES), 0)
    new DataView(out.buffer).setBigUint64(SALT_BYTES, BigInt(counter), false)
    return out
  }

  /** Encrypt bytes for the laptop: nonce ‖ ciphertext. */
  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new ChannelError('channel is not ready; handshake first')
    const iv = this.nonce(this.sendSalt, this.sendCounter)
    this.sendCounter += 1
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      this.key,
      plaintext as BufferSource,
    )
    const sealed = new Uint8Array(NONCE_BYTES + ciphertext.byteLength)
    sealed.set(iv, 0)
    sealed.set(new Uint8Array(ciphertext), NONCE_BYTES)
    return sealed
  }

  /** Decrypt a laptop frame, enforcing the strictly-increasing counter. */
  async open(sealed: Uint8Array): Promise<Uint8Array> {
    if (!this.key || !this.deviceSalt) throw new ChannelError('channel is not ready; handshake first')
    if (sealed.length < NONCE_BYTES + 16) throw new ChannelError('sealed frame is too short')
    const iv = sealed.subarray(0, NONCE_BYTES)
    const expected = this.nonce(this.deviceSalt, this.recvCounter)
    if (!constantTimeEqual(iv, expected)) {
      throw new ChannelError('frame arrived out of order (possible replay)')
    }
    this.recvCounter += 1
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        this.key,
        sealed.subarray(NONCE_BYTES) as BufferSource,
      )
      return new Uint8Array(plaintext)
    } catch {
      throw new ChannelError('frame failed to authenticate')
    }
  }

  async sealText(text: string): Promise<Uint8Array> {
    return this.seal(utf8(text))
  }

  async openText(sealed: Uint8Array): Promise<string> {
    return new TextDecoder().decode(await this.open(sealed))
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}
