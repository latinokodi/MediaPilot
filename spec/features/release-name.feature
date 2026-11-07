@b1 @naming
Feature: Aceptación del nombre del release
  La app no debe dar por bueno un release de OTRA serie solo porque su nombre
  contenga el título (docuserie, spin-off, grupo del release). El título tiene
  que SER el título, o un título alternativo de TMDB, o la parte final del mismo.

  Scenario Outline: Decidir si un release pertenece al título objetivo
    Given los títulos del objetivo son "<titulos>"
    And los títulos alternativos son "<alternativos>"
    When evalúo el release "<release>"
    Then el release se "<resultado>"

    Examples:
      # mismo título, con o sin puntuación, con o sin año
      | release                                                          | titulos                  | alternativos | resultado |
      | FBI S08E01 1080p HEVC x265-MeGusta                               | FBI                      |              | acepta    |
      | FBI.S07E21.MULTi.1080p.WEB.x264-AMB3R                            | FBI                      |              | acepta    |
      | FBI 2018 S08E01 1080p WEB h264-BAE                               | FBI                      |              | acepta    |
      | FBI 8x05 1080p WEB h264-BAE                                      | FBI                      |              | acepta    |
      | Lioness.2023.S03E07.1080p.WEB-DL.DDP5.1.x265-NTb                 | Lioness                  |              | acepta    |
      | The Gentlemen S01E01 1080p WEB h264-ETHEL                        | The Gentlemen            |              | acepta    |
      | Chicago PD S14E01 1080p WEB h264-CAKES                           | Chicago P.D.             |              | acepta    |
      | Star Trek Strange New Worlds S04E09 1080p WEB h264-ETHEL         | Star Trek: Strange New Worlds |         | acepta    |
      | Strange New Worlds S04E09 1080p WEB h264-ETHEL                   | Star Trek: Strange New Worlds |         | acepta    |
      | Special Ops Lioness S03E06 1080p PMTP WEB-DL                     | Lioness                  | Special Ops: Lioness | acepta |
      | Materia oscura S02E04 1080p WEB-DL Dual-Lat                      | Dark Matter              | Materia oscura | acepta  |
      | Dark S01E01 Secrets 1080p NF WEB-DL DUAL DDP5 1 Atmos H 264-Kitsune | Dark                  |              | acepta    |
      | Gentlemen S01E01 1080p WEB h264-ETHEL                            | The Gentlemen            |              | acepta    |
      # otra serie que CONTIENE el título (los que se colaron en producción)
      | The.Dark.S01E02.1080p.WEB.h264-CODSWALLOP                        | Dark                     |              | rechaza   |
      | The Dark S01E04 1080p AMZN WEB-DL DDP2 0 H 264-RAWR              | Dark                     |              | rechaza   |
      | Standoff.The.FBI.Power.and.Paranoia.S01E01.1080p.WEB.h264-BAE    | FBI                      |              | rechaza   |
      | FBI International S01E10 PROPER 1080p WEB h264-GOSSIP            | FBI                      |              | rechaza   |
      | FBI True S01E04 1080p WEB h264-KOGi                              | FBI                      |              | rechaza   |
      | FBI Most Wanted S01E01 1080p WEB h264-CAKES                      | FBI                      |              | rechaza   |
      | Star Trek Discovery S01E01 1080p WEB h264-ETHEL                  | Star Trek: Strange New Worlds |         | rechaza   |
      | Chicago Med S14E01 1080p WEB h264-CAKES                          | Chicago P.D.             |              | rechaza   |
      | American FBI Stories S01E01 1080p WEB                            | FBI                      |              | rechaza   |
      # el spin-off homónimo: "9-1-1" NO es "9-1-1: Nashville" (se colaba y el
      # episodio de la serie original acabó dentro de la carpeta de Nashville)
      | 9-1-1 S10E01 That Sinking Feeling 1080p DSNP WEB-DL DD 5 1 H 264-playWEB | 9-1-1: Nashville |      | rechaza   |
      | 9-1-1 Nashville S02E01 Going Rogue 1080p DSNP WEB-DL DD 5 1 H 264-playWEB | 9-1-1: Nashville |     | acepta    |
      | 9-1-1 S10E01 That Sinking Feeling 1080p DSNP WEB-DL DD 5 1 H 264-playWEB | 9-1-1                  |      | acepta    |

  Scenario: Un release sin nombre reconocible no se bloquea
    Given los títulos del objetivo son "FBI"
    When evalúo el release "S01E01 1080p WEB"
    Then el release se "acepta"
    And la app no bloquea por falta de datos

  # Los releases de anime llevan el nombre TRADUCIDO aunque TMDB guarde el
  # original en japonés: hay que buscar por el latino o la serie no se baja nunca.
  Scenario Outline: Con título original en japonés se busca por el nombre traducido
    Given una serie con título "<original>" y títulos alternativos "<alt>"
    When elijo el título para buscar
    Then el primer título de búsqueda es "Overgeared"

    Examples:
      | original   | alt                                |
      | テムパル～アイテムの力～ | Overgeared: The Power of Items,Overgeared |
      | 템빨 ~아이템의 힘~  | Overgeared,Overgeared ~The Power of Items~ |

  Scenario: Con título latino se busca por ese mismo
    Given una serie con título "FBI" y títulos alternativos "<nada>"
    When elijo el título para buscar
    Then el primer título de búsqueda es "FBI"
