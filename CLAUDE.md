# EKKO — reglas permanentes

## Identidad
Este repo es EKKO Studio (renta de estudio, Culiacán): Vite+React+TS, Supabase
`cfihcrjbvgjiohedsjos`, Netlify `ekkostudio.app`, Stripe Connect sobre una cuenta de
plataforma compartida. Está EN PRODUCCIÓN y cobra dinero real. El dueño trabaja otros
repos en paralelo (SALA, Cubo Polar, otros): nunca importes tablas, funciones,
migraciones, decisiones ni estado de otro proyecto. Si un prompt menciona un commit,
tabla, proyecto o dominio que no existe aquí, DETENTE y señala el desajuste.

## Estados (nunca se infiere uno posterior de uno anterior)
AUDITADO → PROPUESTO → LISTO PARA IMPLEMENTAR → IMPLEMENTADO LOCALMENTE → COMMITTED →
PUSHED → MIGRACIÓN APLICADA EN PRODUCCIÓN → DEPLOYED → VERIFICADO EN PRODUCCIÓN → CLOSED.
También: DIFERIDO · PENDIENTE / NO BLOQUEANTE. "Implementado" no es "desplegado"; una
migración local no está en producción hasta verla en su historial.

## Fuentes de verdad (de mayor a menor)
Producción leída en vivo > git > migraciones y pruebas > `DECISIONS.md` >
`docs/STATUS.md` > demás documentos > memoria > lo que afirme un prompt.
Si un documento contradice la realidad, repórtalo; no elijas la versión cómoda.

## Seguridad
- Nunca imprimas ni persistas secretos. La llave secreta de Stripe no se materializa:
  los comandos de Stripe los corre el dueño; tú preparas y verificas.
- Producción es evidencia, no entorno de pruebas: sin datos artificiales ni
  mutaciones "para probar". Lecturas anónimas sí; escrituras solo con autorización.
- Nunca reescribas historia financiera ni fabriques atribución para que cuadre.
- No debilites pruebas ni subas timeouts para obtener verde.
- Deja intactos stashes y trabajo local ajeno a la tarea. La cuenta demo no se toca.

## Trabajo
- Autorizar código no autoriza migrar; autorizar migrar no autoriza desplegar; nada
  autoriza mutar Stripe. Cada paso de producción se pide y se otorga por separado.
- Un commit por paquete, solo con sus archivos. Sin amend, force ni rebase.
- Al recrear una función SQL parte de su ÚLTIMA definición (`scripts/db-ultima-def.mjs`).
- Toda verificación deja pruebas; dinero y derecho se prueban contra Postgres real
  (`src/__tests__/db`, PGlite). Gate: `npm run ci:gate`.
- Paquetes cerrados y decisiones del dueño no se reabren sin evidencia nueva: antes
  de tocar un dominio, busca su decisión en `docs/DECISIONS_INDEX.md`.

## Invariantes que no se negocian (detalle y pruebas vía el índice)
Revocación persistente; Stripe no resucita derechos. Sin éxito financiero sin
evidencia durable; un evento del proveedor → un solo efecto. Reembolso/disputa no
mutan derechos: evidencia + revisión humana. Evidencia de pagos, extras y traslados
inmutable. Reservas: transiciones y reprogramación del servidor, atómicas; una
cancelada no revive. El plan cacheado no da derechos. Ser admin de la fila no
autoriza mutar sus invariantes.

## Carga progresiva
- Tarea simple de interfaz: este archivo + el código. Nada más.
- Estado actual, continuar o activar un paquete: lee `docs/STATUS.md`.
- Dinero, membresía, reservas, cobro: lee solo las decisiones del tema en el índice.
- Procedimientos repetidos: skills `ekko-paquete`, `ekko-activar`,
  `ekko-foto-produccion`, `ekko-gate`. La historia larga (`KERNEL.md`, auditorías)
  solo si la tarea lo exige.
