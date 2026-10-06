import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

/**
 * PKG-03A · Pendientes operativos del estudio: lo que `v_pendientes_operativos`
 * DERIVA de sus autoridades (revisiones financieras, eventos de Stripe,
 * operaciones de cobro, fallos de entrega, divergencias de membresía). Solo
 * admin (RLS + vista security_invoker). Resolver = una RPC del servidor por
 * dominio; leído/visto NO es resuelto.
 */

export interface PendienteOperativo {
  dominio: 'finanzas' | 'stripe' | 'cobro' | 'entrega' | 'membresia' | 'procesos' | string;
  tipo: string;
  fuente: string;
  fuente_id: string;
  usuario_id: string | null;
  desde: string | null;
  severidad: 'alta' | 'media' | 'baja' | string;
  accion: string;
  ruta: string;
  detalle: string | null;
}

export type ResolucionEvento = 'reenviado_desde_stripe' | 'sin_efecto' | 'ajuste_manual_registrado' | 'otro';

const PESO: Record<string, number> = { alta: 0, media: 1, baja: 2 };

export function useOperacion() {
  const [pendientes, setPendientes] = useState<PendienteOperativo[] | null>(null);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setError(false);
    // Cast: vista nueva, aún no está en los tipos generados de Supabase.
    const { data, error: err } = await (supabase.from as any)('v_pendientes_operativos')
      .select('dominio, tipo, fuente, fuente_id, usuario_id, desde, severidad, accion, ruta, detalle');
    if (err) {
      console.error('[useOperacion]', err.message);
      setError(true);
      setPendientes((prev) => prev ?? []);
      return;
    }
    const lista = ((data ?? []) as PendienteOperativo[]).slice().sort((a, b) =>
      (PESO[a.severidad] ?? 9) - (PESO[b.severidad] ?? 9) || (a.desde ?? '').localeCompare(b.desde ?? ''));
    setPendientes(lista);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  /** Llama la RPC; solo devuelve éxito cuando el servidor lo confirmó (y recarga). */
  const ejecutar = useCallback(
    async (fn: string, args: Record<string, unknown>): Promise<{ error: string | null }> => {
      const { error: err } = await (supabase.rpc as any)(fn, args);
      if (err) return { error: traducirError(err.message) };
      await refetch();
      return { error: null };
    },
    [refetch]
  );

  const resolverEvento = (id: string, resolucion: ResolucionEvento, nota: string) =>
    ejecutar('resolver_evento_stripe', { p_evento_id: id, p_resolucion: resolucion, p_nota: nota });
  const reintentarOperacion = (id: string, nota: string) =>
    ejecutar('staff_reintentar_operacion_cobro', { p_operacion_id: id, p_nota: nota });
  const descartarOperacion = (id: string, nota: string) =>
    ejecutar('staff_descartar_operacion_cobro', { p_operacion_id: id, p_nota: nota });
  const atenderFalloEntrega = (fuente: string, id: string, nota: string) =>
    ejecutar('resolver_fallo_entrega', { p_fuente: fuente, p_id: id, p_nota: nota });
  // PKG-03B: revisar deja constancia; NO cierra (solo la convergencia la cierra).
  const revisarDiscrepancia = (id: string, nota: string) =>
    ejecutar('revisar_discrepancia_stripe', { p_discrepancia_id: id, p_nota: nota });

  // PKG-06G: deja constancia de que se vieron los avisos push no entregados del
  // estudio (todos los pendientes). No reenvía nada.
  const revisarFallosPush = (nota: string) => ejecutar('revisar_fallos_push', { p_nota: nota });

  return { pendientes, error, refetch, resolverEvento, reintentarOperacion, descartarOperacion, atenderFalloEntrega, revisarDiscrepancia, revisarFallosPush };
}

export function traducirError(m: string): string {
  if (m.includes('EKKO_NO_AUTORIZADO')) return 'Solo un admin puede hacer esto.';
  if (m.includes('EKKO_NOTA_REQUERIDA')) return 'Explica qué se hizo (mínimo 10 caracteres).';
  if (m.includes('EKKO_EVENTO_RESUELTO')) return 'Este evento ya estaba resuelto con otra resolución.';
  if (m.includes('EKKO_EVENTO_SIN_PENDIENTE')) return 'Este evento ya no está pendiente.';
  if (m.includes('EKKO_OPERACION_CERRADA')) return 'Esta operación ya está cerrada (aplicada o descartada).';
  if (m.includes('EKKO_DISCREPANCIA_CERRADA')) return 'Esta diferencia ya se corrigió (Stripe y EKKO coinciden).';
  if (m.includes('EKKO_EVENTO_INVALIDO') || m.includes('EKKO_OPERACION_INVALIDA') || m.includes('EKKO_FALLO_INVALIDO')
      || m.includes('EKKO_DISCREPANCIA_INVALIDA')) {
    return 'No se encontró en tu estudio. Recarga la página.';
  }
  return 'No se pudo guardar. Intenta de nuevo.';
}
