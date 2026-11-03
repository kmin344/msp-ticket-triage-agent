import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of the raw request body. */
export function sign(secret: string, payload: Buffer | string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Accepts "<hex>" or "sha256=<hex>". The format check guarantees equal-length
 * buffers before timingSafeEqual (which throws on length mismatch).
 */
export function verifySignature(secret: string, payload: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  return timingSafeEqual(Buffer.from(provided, 'hex'), expected);
}
