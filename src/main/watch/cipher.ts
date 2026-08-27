import { safeStorage } from 'electron'

/**
 * The cipher seam (ADR-0010: "OS keychain where available … falling back to an
 * encrypted file keyed per-machine"). Electron's `safeStorage` is exactly that
 * shape: it derives a key from the OS credential store (Keychain / DPAPI /
 * libsecret) and encrypts a blob we hold ourselves — no new dependency, and no
 * plaintext at rest.
 *
 * It lives behind an interface for two reasons. Test suites cannot import it
 * (`safeStorage` needs a running Electron app, and vitest runs under Node —
 * M0 constraint 3), and a machine with no credential store must produce a
 * *visible* refusal rather than a quiet plaintext fallback (invariant §7).
 *
 * This file is the only place `safeStorage` is touched; nothing else in main
 * imports electron for secrets.
 */

export interface SecretCipher {
  /** Whether credentials can be encrypted on this machine right now. */
  available(): boolean
  /** What backs the encryption, for the visible health state. */
  backend(): string
  /** Contract: returns base64 ciphertext. Throws when unavailable. */
  encrypt(plaintext: string): string
  /** Contract: returns the plaintext for a blob this cipher produced. */
  decrypt(payload: string): string
}

/** The real cipher. Constructed only from `src/main/index.ts`. */
export function safeStorageCipher(): SecretCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    backend: () => {
      if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
      // Linux reports which backend it found; the other platforms have one.
      const linux =
        process.platform === 'linux'
          ? `safeStorage (${safeStorage.getSelectedStorageBackend()})`
          : null
      return linux ?? `safeStorage (${process.platform})`
    },
    encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
    decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64'))
  }
}
