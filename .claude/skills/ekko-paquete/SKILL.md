---
name: ekko-paquete
description: Ciclo completo de un paquete de remediación de EKKO (PKG-… / bloque R…) — auditoría de solo lectura, cruce con lo cerrado, causas raíz, detección de decisiones del dueño, diseño, implementación local autorizada con pruebas, gate y reporte con estados exactos. Úsala cuando el dueño pida auditar, diseñar, implementar o continuar un paquete. Nunca toca producción.
---

# ekko-paquete

Sustituye al prompt largo de cada paquete. El prompt del dueño solo necesita:
alcance (qué paquetes), qué autoriza (auditar / diseñar / implementar en local) y
las decisiones ya tomadas. Lo demás está aquí, en `CLAUDE.md`, en
`docs/STATUS.md` y en `docs/DECISIONS_INDEX.md`.

## 0. Antes de empezar
- Lee `docs/STATUS.md`: qué corre en producción, qué está cerrado, qué hay en local
  sin commit y qué se preserva (stash). Verifícalo contra `git status`,
  `git rev-parse HEAD origin/main` y, si importa, una lectura de producción
  (skill `ekko-foto-produccion`). Si STATUS está viejo, repórtalo.
- Confirma el alcance. Si el prompt nombra algo que no es de EKKO, detente.
- Busca en `docs/DECISIONS_INDEX.md` las decisiones del dominio y léelas en
  `DECISIONS.md`. No las rediscutas; constrúyelas.

## 1. Auditoría (solo lectura)
- Fuentes, en este orden: migraciones (última definición de cada función:
  `node scripts/db-ultima-def.mjs <fn>`), funciones de Netlify, código del front,
  pruebas (`src/__tests__`, `src/__tests__/db`), producción en lectura.
- Para dominios grandes, delega auditorías paralelas en subagentes con preguntas
  cerradas y pide `archivo:línea`; verifica en código cada hallazgo antes de usarlo.
- Cruza con los paquetes cerrados: un hallazgo dentro de un paquete cerrado solo
  es válido con una regresión concreta y reproducible.
- Deduplica: agrupa hallazgos por causa raíz. Severidad P0–P3 sin inflar. P0 =
  dinero o derecho mal hoy, en producción, explotable o en curso.

## 2. Decisiones
Sigue sin preguntar si la conducta ya la fijan: invariantes cerrados, decisiones
existentes, pruebas, textos publicados (Términos, Admin → Reglas) o configuración
explícita. DETENTE y presenta una matriz mínima solo cuando haya varias salidas
razonables que cambien dinero, créditos, cobro o derechos del cliente. Formato por
decisión: ID, conducta actual, por qué es ambigua, opción A, opción B, recomendación,
consecuencias exactas. Las decisiones del dueño se asientan en `DECISIONS.md`
(siguiente `EKKO-NNN`, con su etiqueta original) y en el índice.

## 3. Diseño
Pocas primitivas del servidor (RPC / trigger / función de Netlify), atómicas e
idempotentes, sobre la arquitectura existente. Nada de buses, colas genéricas ni
frameworks. Sin reescribir evidencia histórica ni fabricar atribución. Toda
operación compuesta en UNA transacción. La interfaz representa la regla del
servidor; no la define.

## 4. Implementación local (solo con autorización explícita)
- Migraciones ADITIVAS, numeradas después de la última existente; sin UPDATE ni
  DELETE de datos de negocio; sin backfill inventado. Al recrear una función,
  partir de su última definición y marcar los cambios con el paquete.
- Registra los hashes de las funciones existentes ANTES (`db-foto-produccion
  hashes` o PGlite) y compara DESPUÉS: solo cambian las previstas; lo cerrado
  queda idéntico. Cualquier otra diferencia se investiga.
- Pruebas: cada regla de dinero o derecho tiene una prueba contra Postgres real que
  muerde (`EKKO_DB_HASTA`), más pruebas unitarias de las funciones de Netlify con
  Stripe simulado. Nunca llamadas reales a Stripe.
- Actualiza las pruebas de contrato existentes solo si el contrato cambió a
  propósito, y explica cada una.
- Gate completo con la skill `ekko-gate`. Luego `git diff --check`.

## 5. Límites por defecto (salvo autorización explícita y por separado)
NO migración en producción · NO commit · NO push · NO deploy · NO mutación de
Stripe, Resend ni Netlify · NO datos artificiales en producción · NO tocar el stash
ni trabajo local ajeno · NO empezar el paquete siguiente.

## 6. Reporte y estado
Un solo reporte con: baseline verificado, hallazgos (tabla), causas raíz,
decisiones (o "sin decisiones bloqueantes"), diseño, qué se implementó (archivos,
migraciones con md5, funciones nuevas y cambiadas con hash viejo→nuevo y motivo),
pruebas (N de N, gate completo), compatibilidad con cada paquete cerrado tocado,
foto de producción, estado de git (sin commit/push/deploy, stash intacto),
residuales y UNA recomendación: LISTO PARA ACTIVACIÓN / LISTO PARA DECISIONES DEL
DUEÑO / IMPLEMENTACIÓN INCOMPLETA / STOP — P0.
`docs/STATUS.md` se actualiza solo con lo VERIFICADO (p. ej. "implementado
localmente, gate verde, sin commit"); nunca "cerrado" por haber terminado el código.
Después: STOP y espera.
