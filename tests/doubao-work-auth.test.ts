import { createCipheriv, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptDoubaoCookie } from '../src/doubao-work-auth.ts'

const key = Buffer.alloc(16, 42)
const encrypt = (value: string, host = '.doubao.com', bound = true) => {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const plain = Buffer.concat([bound ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value)])
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()])
}

describe('Doubao Work desktop cookie import', () => {
  it('decodes a host-bound Chromium cookie and rejects a host mismatch', () => {
    const data = encrypt('test-session')
    expect(decryptDoubaoCookie(data, '.doubao.com', key, true)).toBe('test-session')
    expect(decryptDoubaoCookie(data, 'www.doubao.com', key, true)).toBeUndefined()
    expect(decryptDoubaoCookie(data, '.example.com', key, true)).toBeUndefined()
  })
  it('supports old unbound databases and rejects invalid or unsafe values', () => {
    expect(decryptDoubaoCookie(encrypt('legacy', '.doubao.com', false), '.doubao.com', key, false)).toBe('legacy')
    expect(decryptDoubaoCookie(encrypt('a;b'), '.doubao.com', key, true)).toBeUndefined()
    expect(decryptDoubaoCookie(Buffer.from('v20broken'), '.doubao.com', key, true)).toBeUndefined()
    expect(decryptDoubaoCookie(encrypt('data'), '.doubao.com', Buffer.alloc(16), true)).toBeUndefined()
  })
})
