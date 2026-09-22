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
      | Demo S08E01 1080p HEVC x265-MeGusta                               | Demo                      |              | acepta    |
      | Demo.S07E21.MULTi.1080p.WEB.x264-AMB3R                            | Demo                      |              | acepta    |
      | Demo 2018 S08E01 1080p WEB h264-BAE                               | Demo                      |              | acepta    |
      | Demo 8x05 1080p WEB h264-BAE                                      | Demo                      |              | acepta    |
      | Demo9.2023.S03E07.1080p.WEB-DL.DDP5.1.x265-NTb                 | Demo9                  |              | acepta    |
      | Demo8 S01E01 1080p WEB h264-ETHEL                        | Demo8            |              | acepta    |
      | Demo4 S14E01 1080p WEB h264-CAKES                           | Demo4             |              | acepta    |
      | Demo3 S04E09 1080p WEB h264-ETHEL         | Demo3 |         | acepta    |
      | Demo3 S04E09 1080p WEB h264-ETHEL                   | Demo3 |         | acepta    |
      | Special Ops Demo9 S03E06 1080p PMTP WEB-DL                     | Demo9                  | Special Ops: Demo9 | acepta |
      | Demo7 S02E04 1080p WEB-DL Dual-Lat                      | Demo7              | Demo7 | acepta  |
      # otra serie que CONTIENE el título (los que se colaron en producción)
      | Standoff.The.Demo.Power.and.Paranoia.S01E01.1080p.WEB.h264-BAE    | Demo                      |              | rechaza   |
      | Demo International S01E10 PROPER 1080p WEB h264-GOSSIP            | Demo                      |              | rechaza   |
      | Demo True S01E04 1080p WEB h264-KOGi                              | Demo                      |              | rechaza   |
      | Demo Most Wanted S01E01 1080p WEB h264-CAKES                      | Demo                      |              | rechaza   |
      | Star Trek Discovery S01E01 1080p WEB h264-ETHEL                  | Demo3 |         | rechaza   |
      | Demo4 Med S14E01 1080p WEB h264-CAKES                          | Demo4             |              | rechaza   |
      | American Demo Stories S01E01 1080p WEB                            | Demo                      |              | rechaza   |

  Scenario: Un release sin nombre reconocible no se bloquea
    Given los títulos del objetivo son "Demo"
    When evalúo el release "S01E01 1080p WEB"
    Then el release se "acepta"
    And la app no bloquea por falta de datos
