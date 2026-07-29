import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562). node:crypto 만 쓴다 — crypto.randomUUID() 는 버전이 v4로
 * 고정돼 있어 그대로 못 쓴다. 48비트 타임스탬프(ms)는 32비트로 잘리는 일반
 * 비트연산자를 피하려고 BigInt 로 다룬다.
 */
export function uuidv7(now: number = Date.now()): string {
  const ts = BigInt(Math.trunc(now));
  const bytes = new Uint8Array(16);

  for (let i = 0; i < 6; i++) {
    bytes[5 - i] = Number((ts >> BigInt(i * 8)) & 0xffn);
  }

  const rand = randomBytes(10);
  bytes.set(rand, 6);

  // bytes[6]: 상위 니블 = 버전(0111), 하위 니블 = rand_a 상위 4비트
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  // bytes[8]: 상위 2비트 = variant(10), 나머지 = rand_b 상위 6비트
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
