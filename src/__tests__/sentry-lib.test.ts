import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * _lib/sentry.ts — sin DSN es un no-op seguro: reporta a console y deja pasar
 * el handler tal cual. (Con DSN real no se prueba: requeriría red.)
 */

describe('_lib/sentry sin DSN', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SENTRY_DSN;
    delete process.env.VITE_SENTRY_DSN;
  });

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  it('reportarErrorServidor no lanza y deja rastro en console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { reportarErrorServidor, sentryActivo } = await import('../../netlify/functions/_lib/sentry');
    expect(sentryActivo()).toBe(false);
    await expect(reportarErrorServidor('cron-x', new Error('boom'), { a: 1 })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('[cron-x]', 'boom', { a: 1 });
  });

  it('conMonitorCron devuelve la respuesta del handler sin tocarla', async () => {
    const { conMonitorCron } = await import('../../netlify/functions/_lib/sentry');
    const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: '{"ok":true}' });
    const envuelto = conMonitorCron('cron-x', '0 * * * *', handler);
    const res = await envuelto({} as never, {} as never, () => {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ statusCode: 200, body: '{"ok":true}' });
  });
});
