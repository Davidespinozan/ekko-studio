/**
 * Feedback sonoro + táctil para confirmar check-in.
 *
 * - Beep generado con Web Audio API (no requiere asset estático).
 * - Vibración con navigator.vibrate (Android Chrome; iOS Safari NO soporta).
 * - Falla silenciosamente si las APIs no están disponibles o el navegador
 *   bloquea autoplay sin gesture user (raro en este contexto porque el
 *   check-in SÍ es un gesto del recepcionista).
 *
 * Sprint R1 — sin dependencias nuevas.
 */

type AudioContextCtor = typeof AudioContext;

function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function beep(frequency: number, durationMs: number, volume: number): void {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = frequency;
    const now = ctx.currentTime;
    const durSec = durationMs / 1000;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durSec);
    osc.start(now);
    osc.stop(now + durSec);
    // Liberar el contexto cuando termine
    osc.onended = () => {
      try {
        void ctx.close();
      } catch {
        // ignore
      }
    };
  } catch (err) {
    if (typeof console !== 'undefined') console.debug('[checkInFeedback] beep error:', err);
  }
}

function vibrate(pattern: number | number[]): void {
  if (typeof navigator === 'undefined') return;
  if (!('vibrate' in navigator)) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // ignore
  }
}

/** Beep agudo (880 Hz / 200ms) + vibración 100ms. */
export function playCheckInSuccess(): void {
  beep(880, 200, 0.15);
  vibrate(100);
}

/** Beep grave (220 Hz / 400ms) + vibración patrón [100, 50, 100]. */
export function playCheckInError(): void {
  beep(220, 400, 0.2);
  vibrate([100, 50, 100]);
}
