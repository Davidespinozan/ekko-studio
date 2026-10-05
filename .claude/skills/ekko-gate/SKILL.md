---
name: ekko-gate
description: Corre el gate de validación real de EKKO (lint, tsc, pruebas incluidas las de base de datos con PGlite, build, git diff --check) de forma válida y reporta el resultado sin maquillarlo. Úsalo antes de declarar algo IMPLEMENTADO LOCALMENTE, antes de un commit y dentro de una activación.
---

# ekko-gate

El gate es lo que corre Netlify al construir (`netlify.toml` → `command`). Si aquí
está rojo, el deploy no sale.

## Procedimiento
1. **Deriva los comandos del repo**, no de memoria: lee `package.json` → `scripts`
   (`ci:gate` encadena lint, tsc, test y build) y `netlify.toml`. Si cambiaron,
   manda lo que diga el repo.
2. **Espera reposo de la máquina**: carga < 5 y ningún proceso > 200 % CPU. Una
   corrida sobre una máquina cargada o que se suspende a medias da timeouts falsos
   (duraciones de minutos en pruebas de milisegundos = corrida INVÁLIDA, repítela).
   Corre con `caffeinate -dimsu` para que la Mac no se duerma.
3. Limpia la caché de vitest (`rm -rf node_modules/.vite/vitest`) y ejecuta
   `npm run ci:gate` completo. No corras pasos por separado y los sumes: el gate es
   uno. Después, `git diff --check`.
4. Si una suite falla, **clasifica antes de tocar nada**:
   - Falla de aserción o de datos → regresión real. Se arregla el código o se
     reporta; nunca la prueba.
   - Solo "Test timed out" en una prueba que levanta una base (PGlite) y que
     aislada pasa en segundos → infraestructura. Repórtalo aparte. Un límite
     explícito solo se agrega con autorización y con el valor que ya usan las
     suites comparables (120 s en `beforeAll(levantarBase)`), nunca de forma general.
5. Pruebas nuevas de dinero o derecho van en `src/__tests__/db` y deben MORDER:
   corre la suite con `EKKO_DB_HASTA=<timestamp anterior a tu migración>` y
   confirma que falla sin ella.

## Prohibido para "obtener verde"
Cambiar aserciones, saltar o marcar pruebas, subir timeouts, bajar cobertura,
tocar código de aplicación o el gate de Netlify.

## Reporte
Archivos y pruebas (N de N), resultado del build, `git diff --check`, y si hubo
corridas descartadas por carga, dilo con su causa. Un gate verde NO cambia
`docs/STATUS.md` por sí solo; lo cambia el paso del paquete que lo pidió.
