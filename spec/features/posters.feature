# B20 · Pósters en Seguimiento (URLs de TMDB)
#
# ← el fallo original: "MovieDemo" salía sin póster (se añadió por API sin
#   ese campo) y "Demo8"/"Demo8" con una ruta relativa
#   (/ia3jqovf….jpg) que el navegador pedía a MediaPilot en vez de a TMDB → 404.
#   Dos huecos en la parrilla, con todo lo demás funcionando.

@b20
Feature: Los pósters se guardan como URL absoluta y se rellenan si faltan

  Scenario Outline: la ruta relativa de TMDB se convierte en URL absoluta
    When normalizo el póster "<entrada>"
    Then el póster queda como "<salida>"
    Examples:
      | entrada                                                  | salida                                                       |
      | /ia3jqovfKDRlIwbXjiWY6mKUA18.jpg                         | https://image.tmdb.org/t/p/w342/ia3jqovfKDRlIwbXjiWY6mKUA18.jpg |
      | https://image.tmdb.org/t/p/w342/20ZcwtRQ4zMczKg3eB.jpg   | https://image.tmdb.org/t/p/w342/20ZcwtRQ4zMczKg3eB.jpg       |
      |                                                          |                                                              |

  Scenario: un título sin póster lo recibe del detalle de TMDB
    Given un título en seguimiento "MovieDemo" sin póster
    And el detalle de TMDB de "MovieDemo" trae el póster "/xyz123.jpg"
    Then el relleno le pone el póster "https://image.tmdb.org/t/p/w342/xyz123.jpg"

  Scenario: un título que ya tiene póster no se pisa
    # ← caso real: Demo2 ya tiene su URL completa guardada
    Given un título en seguimiento "Demo2" con póster "https://image.tmdb.org/t/p/w342/20ZcwtRQ4zMczKg3eB.jpg"
    And el detalle de TMDB de "Demo2" trae el póster "/otroPoster.jpg"
    Then el relleno no cambia ningún campo

  Scenario: el alta normaliza el póster aunque llegue relativo
    # extremo a extremo sobre la base real (el título de prueba se borra al terminar)
    When añado el título de prueba "ZZ spec poster" con póster "/prueba123.jpg"
    Then el listado lo devuelve con el póster "https://image.tmdb.org/t/p/w342/prueba123.jpg"
    And borro el título de prueba y no queda rastro
