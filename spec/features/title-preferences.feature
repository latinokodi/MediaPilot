# B19 · Idioma por defecto al añadir un título (y lo que se ve en la lista).
#
# ← el fallo original: con "Solo latino" puesto como predeterminado en el Panel,
#   añadir un título desde Seguimiento guardaba latino_first — el desplegable del
#   modal arrancaba fijo en "Latino primero" y el backend, si le llegaba basura,
#   también caía a latino_first en vez de al ajuste. La lista mostraba entonces
#   "Latino primero": la preferencia elegida se perdía.

@b19
Feature: El idioma elegido al añadir se respeta y se ve en la lista

  Scenario Outline: el perfil explícito siempre gana sobre el ajuste
    Given un ajuste de idioma por defecto "<ajuste>"
    When normalizo el perfil enviado "<enviado>"
    Then el perfil resultante es "<esperado>"
    Examples:
      | ajuste        | enviado       | esperado      |
      | latino_first  | latino_only   | latino_only   |
      | latino_first  | english_first | english_first |
      | english_first | latino_first  | latino_first  |
      | latino_only   | latino_only   | latino_only   |

  Scenario Outline: sin perfil (o con basura) manda el ajuste de Ajustes
    Given un ajuste de idioma por defecto "<ajuste>"
    When normalizo el perfil enviado "<enviado>"
    Then el perfil resultante es "<esperado>"
    Examples:
      | ajuste        | enviado | esperado      |
      | latino_only   |         | latino_only   |
      | latino_only   | basura  | latino_only   |
      | english_first |         | english_first |
      | latino_first  |         | latino_first  |
      | basura        |         | latino_first  |

  Scenario: lo que se guarda al añadir es lo que muestra el listado
    # Extremo a extremo sobre la base real (no un doble): usa un tmdb_id
    # inexistente, así que la app no encuentra detalle ni objetivos y no dispara
    # ninguna descarga. El título de prueba se borra y el ajuste se restaura al
    # final del escenario.
    Given que el ajuste de idioma por defecto de la app es "english_first"
    When añado el título de prueba "ZZ spec idioma" sin perfil explícito
    Then el listado lo devuelve con el perfil "english_first"
    When en el título de prueba pongo el perfil "latino_only"
    Then el listado lo devuelve con el perfil "latino_only"
    And borro el título de prueba y restauro el ajuste "latino_first"
