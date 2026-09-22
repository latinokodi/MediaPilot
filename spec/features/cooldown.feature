@b10 @cooldown
Feature: Cooldown del debrid
  En cooldown TorBox sólo acepta releases que YA tiene en caché; el resto falla
  ("did not return a torrent id"). Medido en la cuenta real: cada intento durante
  el cooldown lo ALARGA (03:59 → 08:03 UTC), así que la app no debe martillear ni
  gastar el backoff del episodio: intenta sólo lo cacheado y, si no hay nada,
  difiere sin consumir intento.

  Scenario Outline: En cooldown sólo se intenta lo que ya está en caché
    Given el debrid tiene cooldown hasta "<hasta>"
    And la hora actual es "2026-09-20T05:00:00Z"
    And estos candidatos
      | título                   | cached |
      | Demo S01E01 1080p WEB     | sí     |
      | Demo.S01E02.1080p.x265    | no     |
    When intento bajarlos
    Then se intentan "<esperados>"

    Examples:
      # en cooldown (hasta el día siguiente) → sólo el cacheado
      | hasta                | esperados            |
      | 2026-09-21T08:03:35Z | Demo S01E01 1080p WEB |
      # cooldown ya vencido → todos
      | 2026-09-19T08:03:35Z | Demo S01E01 1080p WEB, Demo.S01E02.1080p.x265 |
      # sin cooldown registrado → todos
      |                      | Demo S01E01 1080p WEB, Demo.S01E02.1080p.x265 |

  Scenario: En cooldown sin nada cacheado el objetivo se difiere, sin gastar intento
    Given el debrid tiene cooldown hasta "2026-09-21T08:03:35Z"
    And la hora actual es "2026-09-20T05:00:00Z"
    And estos candidatos
      | título                   | cached |
      | Demo.S01E02.1080p.x265    | no     |
      | Demo.S01E03.1080p.WEB     | no     |
    When intento bajarlos
    Then el objetivo queda "diferido por cooldown"
    And no se intenta ningún candidato
