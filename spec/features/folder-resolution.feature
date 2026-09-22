@b8 @network
Feature: Carpeta de destino de un título
  El título que publica TMDB cambia con el tiempo y hay series homónimas de
  distintos años: nunca debe crearse una carpeta paralela ni mezclarse dos
  series en la misma carpeta. Si ya hay un duplicado, gana la que más contenido
  tiene.

  Scenario: La carpeta duplicada de un título no recibe contenido nuevo
    Given una biblioteca temporal
    And en la serie "Demo9 (2023)" hay 6 episodios
    And en la serie "Demo9 (2023)" hay 1 episodio
    When resuelvo el destino del release "Demo9 2023 S03E09 1080p WEB-DL" para el tmdb id "113962" del año "2023"
    Then la carpeta de destino es "Demo9 (2023)/Season 3"

  Scenario: Un pack con etiquetas tras la temporada resuelve al título real
    Given una biblioteca temporal
    And en la serie "Demo (2018)" existe la carpeta "Season 1"
    When resuelvo el destino del release "Demo.S01.DLMux.1080p.x264.AC3.ITA-ENG.Sub.ENG.by.quintrix" para el tmdb id "80748" del año "2018"
    Then la carpeta de destino es "Demo (2018)/Season 1"

  Scenario Outline: El título de un release se corta en el primer marcador
    Given evalúo el nombre "<nombre>"
    Then el título del release es "<titulo>"
    And la temporada del release es "<temporada>"

    Examples:
      | nombre                                                       | titulo                       | temporada |
      | Demo.S01.DLMux.1080p.x264.AC3.ITA-ENG.Sub.ENG.by.quintrix     | Demo                          | 1         |
      | Demo.S01.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV              | Demo                          | 1         |
      | demo.s07e20.1080p.web.h264-successfulcrab[EZTVx.to].mkv        | demo                          | 7         |
      | Demo3 S04E09 1080p WEB h264-ETHEL      | Demo3 | 4         |

  Scenario: Película cuyo título cambió deja de duplicarse
    Given una biblioteca temporal
    And en películas existe el archivo "El tigre y el dragón (2000)/El.tigre.y.el.dragon.2000.mkv"
    And en películas existe la carpeta "Tigre y dragón (2000)"
    When resuelvo el destino del release "Tigre.y.dragon.2000.1080p-Dual-Lat" para el tmdb id "146" del año "2000"
    Then la carpeta de destino es "El tigre y el dragón (2000)"

  Scenario: Dos series homónimas de años distintos no se mezclan
    Given una biblioteca temporal
    And en la serie "Demo7 (2015)" hay 3 episodios
    And en la serie "Demo7 (2024)" hay 1 episodio
    When resuelvo el destino del release "Demo7 2024 S02E05 1080p WEB" para el tmdb id "196322" del año "2024"
    Then la carpeta de destino es "Demo7 (2024)/Season 2"

  Scenario: Consolidar un duplicado ya existente sin perder nada
    Given una biblioteca temporal
    And en la serie "Demo9 (2023)" existe el archivo "Season 5/Demo9 S05E01 1080p WEB.mkv"
    And en la serie "Demo9 (2023)" existe el archivo "Season 5/Demo9 S05E04 1080p WEB.mkv"
    And en la serie "Demo9 (2023)" existe el archivo "Season 5/Demo9 S05E04 1080p WEB.spa.srt"
    When ejecuto la reparación de la biblioteca
    Then existe "Demo9 (2023)/Season 5/Demo9 S05E04 1080p WEB.mkv"
    And existe "Demo9 (2023)/Season 5/Demo9 S05E04 1080p WEB.spa.srt"
