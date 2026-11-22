@b26 @monitor
Feature: Temporada en curso y grabs fantasma
  Dos fallos dejaban huecos invisibles en la biblioteca: el monitor elegía una
  temporada vacía anunciada por TMDB y se quedaba "(idle)" para siempre, y daba
  por hecha una descarga que nunca llegó al disco.

  Scenario: TMDB anuncia una temporada futura sin episodios
    Given estas temporadas de TMDB
      | temporada | episodios |
      | 1         | 10        |
      | 2         | 0         |
    Then la temporada en curso es 1

  Scenario: Varias temporadas con episodios
    Given estas temporadas de TMDB
      | temporada | episodios |
      | 1         | 22        |
      | 2         | 22        |
      | 3         | 6         |
    Then la temporada en curso es 3

  Scenario: Una temporada anunciada sin fecha no tapa la real
    Given estas temporadas de TMDB
      | temporada | episodios |
      | 1         | 8         |
      | 2         | 8         |
      | 3         | 0         |
    Then la temporada en curso es 2

  Scenario: Un grab cuyo archivo ya no está en el disco no cuenta como hecho
    Given un grab registrado de "Stuart" S01E09 con archivo "Stuart S01E09.mkv"
    And la carpeta de destino no contiene "Stuart S01E09.mkv"
    Then el episodio "S01E09" no cuenta como descargado

  Scenario: Un grab con el archivo presente sí cuenta como hecho
    Given un grab registrado de "Stuart" S01E09 con archivo "Stuart S01E09.mkv"
    And la carpeta de destino contiene "Stuart S01E09.mkv"
    Then el episodio "S01E09" cuenta como descargado
