@b3 @queue
Feature: Orden de la cola
  Lo recién emitido va primero (para no perder el capítulo de la semana), y el
  backfill de una serie se baja EN ORDEN desde la primera temporada, no de la
  más nueva hacia atrás.

  Scenario: Serie añadida hoy con temporadas antiguas por bajar
    Given una serie añadida el "2026-09-20" con estos episodios ya emitidos
      | temporada | episodio | fecha      |
      | 1         | 1        | 2018-09-25 |
      | 1         | 2        | 2018-10-02 |
      | 2         | 1        | 2019-09-24 |
      | 8         | 5        | 2026-03-10 |
      | 8         | 6        | 2026-04-01 |
    When ordeno la cola de descarga
    Then el primer objetivo es "S01E01"
    And el orden de la cola es "S01E01, S01E02, S02E01, S08E05, S08E06"

  Scenario: Un capítulo recién emitido se cuela delante del backfill
    Given una serie añadida el "2026-09-01" con estos episodios ya emitidos
      | temporada | episodio | fecha      |
      | 1         | 1        | 2018-09-25 |
      | 1         | 2        | 2018-10-02 |
      | 9         | 1        | 2026-09-15 |
      | 9         | 2        | 2026-09-22 |
    When ordeno la cola de descarga
    Then el orden de la cola es "S09E02, S09E01, S01E01, S01E02"

  Scenario: Reintento atrasado (sin fecha) también respeta el orden
    Given una serie añadida el "2026-09-01" con estos episodios ya emitidos
      | temporada | episodio | fecha |
      | 3         | 1        |       |
      | 2         | 4        |       |
      | 2         | 2        |       |
    When ordeno la cola de descarga
    Then el orden de la cola es "S02E02, S02E04, S03E01"
