@b5 @library
Feature: Estructura de la biblioteca para Jellyfin
  Series: <serie>/Season N/<video> · Películas: <Película (Año)>/<video>.
  La app recoloca sola lo que no está donde Jellyfin lo ve, sin sobrescribir
  nunca y sin cambiar nada cuando la biblioteca ya está correcta.

  Scenario: Recolocar lo que Jellyfin no vería
    Given una biblioteca temporal
    And en la serie "Prueba (2020)" existe el archivo "Prueba S02E01 1080p WEB.mkv"
    And en la serie "Prueba (2020)" existe el archivo "Season 1/Prueba S01E01 1080p WEB.mkv"
    And en la serie "Prueba (2020)" existe el archivo "Season 1/Release/Prueba S01E03 1080p WEB.mkv"
    And en la serie "Prueba (2020)" existe la carpeta "Season 3"
    When ejecuto la reparación de la biblioteca
    Then existe "Prueba (2020)/Season 2/Prueba S02E01 1080p WEB.mkv"
    And no existe "Prueba (2020)/Prueba S02E01 1080p WEB.mkv"
    And existe "Prueba (2020)/Season 1/Prueba S01E03 1080p WEB.mkv"
    And no existe "Prueba (2020)/Season 1/Release"
    And no existe "Prueba (2020)/Season 3"
    And existe "Prueba (2020)/Season 1/Prueba S01E01 1080p WEB.mkv"

  Scenario: Recolocar películas que Jellyfin no vería
    Given una biblioteca temporal
    And en películas existe el archivo "Pelicula Suelta 2019 1080p.mkv"
    And en películas existe el archivo "Otra Pelicula (2021)/Release/otra.mkv"
    When ejecuto la reparación de la biblioteca
    Then existe "Pelicula Suelta (2019)/Pelicula Suelta 2019 1080p.mkv"
    And existe "Otra Pelicula (2021)/otra.mkv"
    And no existe "Otra Pelicula (2021)/Release"

  Scenario: Una segunda pasada no toca nada
    Given una biblioteca temporal
    And en la serie "Prueba (2020)" existe el archivo "Season 1/Prueba S01E01 1080p WEB.mkv"
    When ejecuto la reparación de la biblioteca
    Then la reparación no movió ni borró nada

  Scenario: Nunca sobrescribe un archivo que ya está en el destino
    Given una biblioteca temporal
    And en la serie "Prueba (2020)" existe el archivo "Prueba S01E01 1080p WEB.mkv"
    And en la serie "Prueba (2020)" existe el archivo "Season 1/Prueba S01E01 1080p WEB.mkv"
    When ejecuto la reparación de la biblioteca
    Then existe "Prueba (2020)/Season 1/Prueba S01E01 1080p WEB.mkv"
    And existe "Prueba (2020)/Prueba S01E01 1080p WEB.mkv"
