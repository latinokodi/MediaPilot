@b2 @preflight
Feature: Preflight de duración
  Un episodio de otra serie homónima se detecta por duración ANTES de bajar el
  archivo: se lee la duración de la cabecera del contenedor con unos pocos MB.

  Scenario Outline: Comparar duración real con la esperada
    Given la duración esperada es "<esperado>" minutos para un "<tipo>"
    When la duración real del video es "<real>" minutos
    Then la duración "<resultado>"

    Examples:
      # Demo7 2015 (43 min) buscado para el S02E04 de 2024 (53 min)
      | esperado | real | tipo    | resultado |
      | 53       | 43   | episodio | rechaza  |
      | 43       | 43   | episodio | acepta   |
      | 43       | 42.9 | episodio | acepta   |
      | 43       | 40.6 | episodio | acepta   |
      | 43       | 36   | episodio | rechaza  |
      | 120      | 120.3 | película | acepta  |
      | 120      | 96   | película | rechaza  |
      | 0        | 43   | episodio | acepta   |

  Scenario: Sin duración esperada no se bloquea
    Given la duración esperada es "" minutos para un "episodio"
    When la duración real del video es "43" minutos
    Then la duración "acepta"
    And el preflight es "inconcluso"
