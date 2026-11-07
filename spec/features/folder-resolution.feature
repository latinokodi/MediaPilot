@b8 @network
Feature: Carpeta de destino de un título
  El título que publica TMDB cambia con el tiempo y hay series homónimas de
  distintos años: nunca debe crearse una carpeta paralela ni mezclarse dos
  series en la misma carpeta. Si ya hay un duplicado, gana la que más contenido
  tiene.

  Scenario: La carpeta duplicada de un título no recibe contenido nuevo
    Given una biblioteca temporal
    And en la serie "Operativo Lioness (2023)" hay 6 episodios
    And en la serie "Lioness (2023)" hay 1 episodio
    When resuelvo el destino del release "Lioness 2023 S03E09 1080p WEB-DL" para el tmdb id "113962" del año "2023"
    Then la carpeta de destino es "Operativo Lioness (2023)/Season 3"

  Scenario: Un pack con etiquetas tras la temporada resuelve al título real
    Given una biblioteca temporal
    And en la serie "FBI (2018)" existe la carpeta "Season 1"
    When resuelvo el destino del release "FBI.S01.DLMux.1080p.x264.AC3.ITA-ENG.Sub.ENG.by.quintrix" para el tmdb id "80748" del año "2018"
    Then la carpeta de destino es "FBI (2018)/Season 1"

  Scenario Outline: El título de un release se corta en el primer marcador
    Given evalúo el nombre "<nombre>"
    Then el título del release es "<titulo>"
    And la temporada del release es "<temporada>"

    Examples:
      | nombre                                                       | titulo                       | temporada |
      | FBI.S01.DLMux.1080p.x264.AC3.ITA-ENG.Sub.ENG.by.quintrix     | FBI                          | 1         |
      | FBI.S01.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV              | FBI                          | 1         |
      | fbi.s07e20.1080p.web.h264-successfulcrab[EZTVx.to].mkv        | fbi                          | 7         |
      | Star Trek Strange New Worlds S04E09 1080p WEB h264-ETHEL      | Star Trek Strange New Worlds | 4         |

  Scenario: Película cuyo título cambió deja de duplicarse
    Given una biblioteca temporal
    And en películas existe el archivo "El tigre y el dragón (2000)/El.tigre.y.el.dragon.2000.mkv"
    And en películas existe la carpeta "Tigre y dragón (2000)"
    When resuelvo el destino del release "Tigre.y.dragon.2000.1080p-Dual-Lat" para el tmdb id "146" del año "2000"
    Then la carpeta de destino es "El tigre y el dragón (2000)"

  Scenario: Dos series homónimas de años distintos no se mezclan
    Given una biblioteca temporal
    And en la serie "Dark Matter (2015)" hay 3 episodios
    And en la serie "Dark Matter (2024)" hay 1 episodio
    When resuelvo el destino del release "Dark Matter 2024 S02E05 1080p WEB" para el tmdb id "196322" del año "2024"
    Then la carpeta de destino es "Dark Matter (2024)/Season 2"

  Scenario: Consolidar un duplicado ya existente sin perder nada
    Given una biblioteca temporal
    And en la serie "Operativo Lioness (2023)" existe el archivo "Season 5/Operativo Lioness S05E01 1080p WEB.mkv"
    And en la serie "Lioness (2023)" existe el archivo "Season 5/Lioness S05E04 1080p WEB.mkv"
    And en la serie "Lioness (2023)" existe el archivo "Season 5/Lioness S05E04 1080p WEB.spa.srt"
    When ejecuto la reparación de la biblioteca
    Then existe "Operativo Lioness (2023)/Season 5/Lioness S05E04 1080p WEB.mkv"
    And existe "Operativo Lioness (2023)/Season 5/Lioness S05E04 1080p WEB.spa.srt"
