import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * PKG-01G · Revisiones financieras (reembolsos, disputas, orígenes no
 * resueltos, reconciliación, cuenta desautorizada). Lectura admin-only por RLS.
 * Resolver = documentar: NUNCA muta créditos, membresías ni reservas.
 */

export interface ReversalResumen {
  id: string;
  tipo: string; // reembolso | disputa
  stripe_object_id: string;
  stripe_charge_id: string;
  monto_centavos: number;
  moneda: string;
  estado_proveedor: string;
  motivo_proveedor: string | null;
  pago_origen_id: string | null;
  membresia_origen_id: string | null;
  usuario_id: string | null;
  stripe_created_at: string | null;
}

export interface RevisionFinanciera {
  id: string;
  tipo: string;
  referencia: string | null;
  estado: string; // abierta | resuelta
  resolucion: string | null;
  nota: string | null;
  detalle: Record<string, unknown>;
  actor_rol: string | null;
  abierta_at: string;
  resuelta_at: string | null;
  reabierta_at: string | null;
  reversal: ReversalResumen | null;
  /** Nombre del miembro del reversal (si se resolvió el origen). */
  miembro_nombre: string | null;
}

export type ResolucionHumana = 'sin_efecto' | 'ajuste_manual_registrado' | 'otro';

export const LABEL_TIPO_REVISION: Record<string, string> = {
  reembolso: 'Reembolso',
  disputa_abierta: 'Disputa abierta',
  disputa_perdida: 'Disputa perdida',
  origen_no_resuelto: 'Reembolso sin pago de origen',
  origen_ambiguo: 'Reembolso con origen ambiguo',
  reconciliacion_reembolso: 'Reembolso por reconciliar',
  cuenta_desautorizada: 'Cuenta de Stripe desconectada',
  vinculo_valor_pendiente: 'Vínculo de valor pendiente',
  invitados_extra_no_aplicado: 'Pago de invitados extra sin aplicar',
  credito_no_restaurado: 'Crédito sin restaurar (membresía terminada)',
  extras_pagados_reserva_cancelada: 'Reserva cancelada con invitados extra pagados'
};

export const LABEL_RESOLUCION: Record<string, string> = {
  sin_efecto: 'Revisada, sin efecto',
  disputa_ganada: 'Disputa ganada',
  reconciliado: 'Reconciliado',
  ajuste_manual_registrado: 'Ajuste manual registrado',
  otro: 'Otro'
};

export function useRevisionesFinancieras(opts: { soloAbiertas?: boolean; usuarioId?: string } = {}) {
  const tenant = useTenant();
  const [revisiones, setRevisiones] = useState<RevisionFinanciera[] | null>(null);
  const [error, setError] = useState(false);
  const { soloAbiertas = false, usuarioId } = opts;

  const refetch = useCallback(async () => {
    setError(false);
    try {
      let q = supabase
        .from('revisiones_financieras')
        .select('id, tipo, referencia, estado, resolucion, nota, detalle, actor_rol, abierta_at, resuelta_at, reabierta_at, reversal_id')
        .eq('tenant_id', tenant.id)
        .order('abierta_at', { ascending: false })
        .limit(200);
      if (soloAbiertas) q = q.eq('estado', 'abierta');
      const { data: filas, error: err } = await q;
      if (err) throw err;

      const ids = Array.from(new Set((filas ?? []).map((f) => f.reversal_id).filter((x): x is string => Boolean(x))));
      const reversales = new Map<string, ReversalResumen>();
      if (ids.length) {
        const { data: rv, error: errRv } = await supabase
          .from('reversales_pago')
          .select('id, tipo, stripe_object_id, stripe_charge_id, monto_centavos, moneda, estado_proveedor, motivo_proveedor, pago_origen_id, membresia_origen_id, usuario_id, stripe_created_at')
          .in('id', ids);
        if (errRv) throw errRv;
        for (const r of rv ?? []) reversales.set(r.id, r as ReversalResumen);
      }
      const usuarios = Array.from(new Set(Array.from(reversales.values()).map((r) => r.usuario_id).filter((x): x is string => Boolean(x))));
      const nombres = new Map<string, string | null>();
      if (usuarios.length) {
        const { data: us } = await supabase.from('usuarios').select('id, nombre').in('id', usuarios);
        for (const u of us ?? []) nombres.set(u.id, u.nombre);
      }

      let lista: RevisionFinanciera[] = (filas ?? []).map((f) => {
        const reversal = f.reversal_id ? reversales.get(f.reversal_id) ?? null : null;
        return {
          id: f.id,
          tipo: f.tipo,
          referencia: f.referencia,
          estado: f.estado,
          resolucion: f.resolucion,
          nota: f.nota,
          detalle: (f.detalle ?? {}) as Record<string, unknown>,
          actor_rol: f.actor_rol,
          abierta_at: f.abierta_at,
          resuelta_at: f.resuelta_at,
          reabierta_at: f.reabierta_at,
          reversal,
          miembro_nombre: reversal?.usuario_id ? nombres.get(reversal.usuario_id) ?? null : null
        };
      });
      if (usuarioId) lista = lista.filter((r) => r.reversal?.usuario_id === usuarioId);
      setRevisiones(lista);
    } catch (e) {
      console.error('[useRevisionesFinancieras]', e instanceof Error ? e.message : e);
      setError(true);
      setRevisiones([]);
    }
  }, [tenant.id, soloAbiertas, usuarioId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const resolver = useCallback(
    async (revisionId: string, resolucion: ResolucionHumana, nota: string): Promise<{ error: string | null }> => {
      const { error: err } = await supabase.rpc('resolver_revision_financiera', {
        p_revision_id: revisionId,
        p_resolucion: resolucion,
        p_nota: nota
      });
      if (err) return { error: traducirError(err.message) };
      await refetch();
      return { error: null };
    },
    [refetch]
  );

  return { revisiones, error, refetch, resolver };
}

function traducirError(m: string): string {
  if (m.includes('EKKO_NO_AUTORIZADO')) return 'Solo un admin puede resolver revisiones financieras.';
  if (m.includes('EKKO_NOTA_REQUERIDA')) return 'Explica la resolución (mínimo 10 caracteres).';
  if (m.includes('EKKO_REVISION_RESUELTA')) return 'Esta revisión ya estaba resuelta con otra resolución.';
  if (m.includes('EKKO_REVISION_INVALIDA')) return 'Revisión no encontrada.';
  return 'No se pudo resolver la revisión.';
}
