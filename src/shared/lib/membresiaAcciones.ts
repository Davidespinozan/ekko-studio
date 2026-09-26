import { estadoMembresia, esPaqueteDeCreditos, type EstadoMembresiaUI } from './membresiaEstado';

/**
 * Qué puede hacer el staff con la membresía de un miembro, según el ESTADO DE LA
 * MEMBRESÍA — no según `usuarios.status`.
 *
 * La ficha de recepción decidía por el status de la CUENTA, y de ahí salían tres
 * bugs: un miembro en pausa (cuenta `suspendido`) veía "Activar membresía" y se le
 * creaba una segunda membresía; a uno `activo` al que se le acabó el paquete no se
 * le ofrecía NADA (el caso más común del mostrador); y nadie podía cambiar de plan
 * sin pasar por "Editar datos". (SALA: SocioFicha.tsx:403-424.)
 */
export type AccionMembresia =
  | 'asignar' // no tiene plan → elegir uno
  | 'renovar' // venció / se quedó sin créditos → mismo plan otra vez
  | 'cambiar' // pasar a otro plan
  | 'pausar'
  | 'reanudar'
  | 'ajustar_creditos'
  | 'dar_de_baja';

export interface MembresiaParaAcciones {
  status: string;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  cancel_at_period_end?: boolean | null;
  stripe_subscription_id?: string | null;
  tier: { tipo: string | null } | null;
}

export interface AccionesMembresia {
  estado: EstadoMembresiaUI;
  /** Paquete sin saldo: vigente por fecha, pero no puede reservar. */
  sinCreditos: boolean;
  /** La acción que recepción casi seguro quiere (botón dorado). */
  principal: AccionMembresia | null;
  secundarias: AccionMembresia[];
}

export function accionesDeMembresia(
  m: MembresiaParaAcciones | null,
  ahora: Date = new Date()
): AccionesMembresia {
  const estado = estadoMembresia(m, ahora);
  if (!m) return { estado, sinCreditos: false, principal: 'asignar', secundarias: [] };

  const paquete = esPaqueteDeCreditos(m.tier?.tipo);
  const sinCreditos = paquete && (m.creditos_restantes ?? 0) <= 0;
  const ajuste: AccionMembresia[] = paquete ? ['ajustar_creditos'] : [];

  if (estado === 'pausada') {
    return { estado, sinCreditos, principal: 'reanudar', secundarias: ['cambiar', ...ajuste, 'dar_de_baja'] };
  }
  // Con suscripción Stripe la renovación es automática: "Renovar" a mano crearía
  // una membresía de mostrador encima de la suscripción. Ahí manda Stripe (una
  // fecha vencida suele ser solo el invoice.paid que aún no llega).
  const conStripe = Boolean(m.stripe_subscription_id);

  if (!conStripe && (estado === 'vencida' || sinCreditos)) {
    // Vencida / sin saldo no se pausa: no hay nada que congelar.
    return { estado, sinCreditos, principal: 'renovar', secundarias: ['cambiar', ...ajuste, 'dar_de_baja'] };
  }

  // vigente · por_vencer · pago_pendiente (y vencida por fecha con Stripe)
  const baja: AccionMembresia[] = m.cancel_at_period_end ? [] : ['dar_de_baja'];
  return {
    estado,
    sinCreditos,
    principal: !conStripe && estado === 'por_vencer' ? 'renovar' : null,
    secundarias: ['cambiar', 'pausar', ...ajuste, ...baja]
  };
}

export const ACCION_MEMBRESIA_LABEL: Record<AccionMembresia, string> = {
  asignar: 'Asignar plan',
  renovar: 'Renovar',
  cambiar: 'Cambiar plan',
  pausar: 'Pausar',
  reanudar: 'Reanudar membresía',
  ajustar_creditos: 'Ajustar créditos',
  dar_de_baja: 'Dar de baja'
};
