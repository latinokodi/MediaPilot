@b13 @b14 @b15 @b16
Feature: Lo que la app hace sola al terminar una descarga
  Todo esto se hacía A MANO cada vez que llegaba un pack. Debe funcionar para
  cualquier serie/película de la watchlist, sin nombres ni ids concretos.

  Scenario Outline: De qué episodio es un archivo descargado
    Given el archivo se llama "<archivo>"
    When miro su episodio
    Then es de la temporada "<temporada>" episodio "<episodio>"

    Examples:
      | archivo                                                             | temporada | episodio |
      | Demo.S01E01.La.legge.di.Godwin.DLMux.1080p.x264.AC3.ITA-ENG.mkv      | 1         | 1        |
      | demo.s07e20.1080p.web.h264-successfulcrab[EZTVx.to].mkv              | 7         | 20       |
      | Demo - S07E16 - Covered.mkv                                          | 7         | 16       |
      | Demo10.1x05.1080p.WEB.mkv                                          | 1         | 5        |

  Scenario: Un archivo sin episodio no se inventa una temporada
    Given el archivo se llama "El.tigre.y.el.dragon.2000.WEB-DL.1080p-Dual-Lat.mkv"
    When miro su episodio
    Then no tiene episodio

  Scenario Outline: Orden de las pistas de audio
    Given las pistas de audio son "<pistas>"
    When decido si hay que reordenar el audio
    Then el orden final del audio es "<orden>"

    Examples:
      # el italiano primero (packs DLMux): hay que poner el inglés delante
      | pistas       | orden        |
      | ita,eng      | eng,ita      |
      | ita,eng,fra  | eng,ita,fra  |
      # el inglés ya está primero: no se toca
      | eng,ita      | eng,ita      |
      | eng          | eng          |
      # ningún idioma preferido: se deja como está (no hay nada que ganar)
      | ita,fra      | ita,fra      |
      # el español (latino) manda sobre el inglés
      | eng,spa      | spa,eng      |

  Scenario Outline: Torrents atascados en el debrid
    Given un torrent en estado "<estado>" creado hace <edad> minutos
    And el límite de torrents atascados es "120" minutos
    When compruebo si hay que liberar su plaza
    Then el torrent "<resultado>"

    Examples:
      | estado      | edad  | resultado        |
      | checking    | 200   | se libera        |
      | checking    | 30    | no se libera     |
      | metadl      | 180   | se libera        |
      | incomplete  | 600   | se libera        |
      | cached      | 600   | no se libera     |
      | completed   | 600   | no se libera     |
      # con transferencia en marcha se espera 4x el límite (480 min) antes de liberar
      | downloading | 600   | se libera        |
      | downloading | 300   | no se libera     |
