# spec/ — especificación viva de MediaPilot

Este directorio es **la fuente de verdad del comportamiento** de la app. El
código se escribe para cumplir el spec; si algo no está aquí y queremos que sea
un contrato, se añade primero aquí.

## Cómo funciona (SDD → BDD → TDD)

1. **SDD (spec primero)** — `mediapilot-grab-pipeline.md`: objetivo, stack,
   comandos, estructura, estilo, estrategia de pruebas, límites y las
   **conductas numeradas** (B1…B8) con sus criterios de éxito verificables.
   Nada se implementa sin una conducta que lo pida.
2. **BDD (comportamiento)** — `features/*.feature` en Gherkin: cada conducta se
   escribe como escenarios en lenguaje del usuario (`Scenario Outline` para las
   tablas de casos). Es la documentación que cualquiera puede leer y discutir.
3. **TDD (rojo → verde → refactor)** — `npm run spec` ejecuta los `.feature`
   **contra los módulos reales** de la app (no contra dobles de las funciones de
   dominio). El ciclo es: escribir el escenario (rojo) → implementar lo mínimo
   (verde) → limpiar. Una rodaja a la vez, nunca "todos los tests y luego todo el
   código".

```
spec/
  mediapilot-grab-pipeline.md   # el contrato (SDD)
  features/*.feature            # escenarios (BDD)
  support/gherkin.ts            # parser mínimo de Gherkin
  support/steps.ts              # pasos → funciones reales de electron/
  support/run.ts                # runner: reporte + código de salida
```

## Uso

```bash
npm run spec                        # todos los escenarios (incluye red/TMDB)
npm run spec -- --skip=@network     # sin red
npm run spec -- --feature=naming    # solo los .feature que contengan "naming"
```

Salida: una línea por escenario con `PASS`/`FAIL`, el paso y el motivo del fallo;
código de salida 1 si algo falla (sirve como puerta antes de commitear).

Etiquetas:

- `@b1`…`@b8` — conducta del spec a la que pertenece el escenario.
- `@network` — necesita internet y/o la API de TMDB (la resolución de carpetas
  consulta TMDB de verdad; requiere `TMDB_API_KEY` en el entorno).
- `@manual` — comportamiento documentado pero no automatizable (la concurrencia
  real exige el servicio en marcha y un debrid de verdad).

## Reglas de convivencia

- Los escenarios **no tocan la biblioteca real**: usan sandboxes en `/tmp`
  (temporales, borrados al terminar).
- El único estado compartido es la tabla `media_folders` (la resolución de
  carpetas la consulta y la escribe); el runner la **fotografía al empezar y la
  restaura al terminar**.
- La app en producción (`tordownloader.service`) no se toca desde el spec.
- Antes de commitear: `npm run spec` y el typecheck de `electron/*.ts`.

## Historial de por qué existe (fallos reales que ahora son escenarios)

- `Standoff.The.Demo.Power.and.Paranoia`, `Demo International` y `Demo True`
  entraron en `Demo (2018)`: el comparador aceptaba el título como subcadena o con
  un token de más. Hoy el título tiene que **ser** el título (o un alt title de
  TMDB, o la parte final del mismo) → `release-name.feature`.
- `Demo7 S02E04` (serie de 2024) se bajó de la serie de 2015 (43 min vs 53):
  ahora la duración se verifica con la cabecera antes de bajar nada →
  `duration-preflight.feature`.
- La carpeta creada por un cambio de título de TMDB se quedaba con lo nuevo:
  hoy consolida en la carpeta **memorizada** en `media_folders` →
  `folder-resolution.feature` y `library-layout.feature`.

Método: **spec-driven development** con ciclo BDD → TDD
(escenario primero, lógica pura después, y por último el cableado a la base real).
