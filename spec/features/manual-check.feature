# B18 · La comprobación manual ("Verificar ahora") intenta de verdad.
#
# ← el fallo original: Demo2 S01E06 acumuló 5 intentos y quedó esperando
#   hasta 2026-09-21T06:49:28Z. Pulsar "Verificar ahora" a las 03:16 devolvía
#   grabbed=0 waiting=0 deferred=1, sin intentar nada: el capítulo parecía
#   muerto cuando sólo estaba en la ventana de reintento.

@b18
Feature: Verificar ahora ignora la ventana de reintento

  Scenario: un objetivo en espera se intenta igualmente al forzar
    # datos reales del caso de Demo2 S01E06 (21/09, 03:16 Bogotá)
    Given un intento pendiente con próxima fecha "2026-09-21T06:49:28.000Z" y 5 intentos
    And la hora actual es "2026-09-21T03:16:00.000Z"
    When compruebo ese intento sin forzar
    Then el intento queda diferido
    When compruebo ese intento forzando
    Then el intento no queda diferido

  Scenario Outline: sólo se difiere un intento con ventana futura y sin forzar
    Given un intento pendiente con próxima fecha "<next>" y <n> intentos
    And la hora actual es "2026-09-21T03:16:00.000Z"
    When compruebo ese intento <modo>
    Then el intento <esperado>
    Examples:
      | next                     | n | modo       | esperado          |
      | 2026-09-21T08:00:00.000Z | 3 | sin forzar | queda diferido    |
      | 2026-09-21T08:00:00.000Z | 3 | forzando   | no queda diferido |
      | 2026-09-21T02:00:00.000Z | 2 | sin forzar | no queda diferido |
      |                          | 0 | sin forzar | no queda diferido |

  Scenario Outline: un fallo forzado no alarga la espera
    # el calendario real de reintentos: 1h → 2h → 4h → 8h → 12h → diario
    When calculo el próximo reintento <modo> tras el intento <n>
    Then el próximo reintento es <esperado>
    Examples:
      | modo       | n | esperado |
      | sin forzar | 1 | 60       |
      | sin forzar | 5 | 720      |
      | forzando   | 5 | ninguno  |
