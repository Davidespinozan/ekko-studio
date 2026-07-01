import { describe, it, expect, afterEach } from 'vitest';
import { pushSoportado, esIOS, necesitaInstalar } from '@shared/lib/push';

/**
 * Helpers de detección del cliente push. En jsdom no hay serviceWorker/PushManager,
 * así que pushSoportado es false; validamos además la rama iOS "necesita instalar".
 */

const originalUA = navigator.userAgent;
function setUA(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}
afterEach(() => setUA(originalUA));

describe('push (cliente)', () => {
  it('sin serviceWorker/PushManager (jsdom) → no soportado', () => {
    expect(pushSoportado()).toBe(false);
  });

  it('detecta iOS por user agent', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari');
    expect(esIOS()).toBe(true);
    setUA('Mozilla/5.0 (Windows NT 10.0) Chrome/120');
    expect(esIOS()).toBe(false);
  });

  it('iOS sin instalar (no standalone) → necesita instalar', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari');
    expect(necesitaInstalar()).toBe(true);
  });
});
