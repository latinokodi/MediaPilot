@b11 @quality
Feature: Calidad mínima aceptable
  El usuario fijó el mínimo en 1080p: no se bajan copias 720p ni menores por el
  pipeline automático (el 720p de S04/S05 y el pack de S03 se descartaron por
  esto). Si el nombre no dice resolución no se bloquea — no se descarta por falta
  de datos. Los añadidos a mano los elige el usuario y no pasan por esta regla.

  Scenario Outline: Decidir si un release cumple la calidad mínima
    Given la calidad mínima es "1080p"
    When evalúo la calidad del release "<release>"
    Then el release "<resultado>"

    Examples:
      | release                                              | resultado      |
      | Demo S03E01 1080p WEB x264-ETHEL                      | cumple         |
      | Demo.S01.COMPLETE.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX | cumple         |
      | Demo 2018 Season 7 Complete 1080p WEB x264 [i_c]      | cumple         |
      | Demo S03E01 2160p WEB-DL DDP5                        | cumple         |
      | Demo S03E01 4K HDR WEB-DL                            | cumple         |
      | Demo.S03.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV      | no cumple      |
      | Demo S05E12 720p AMZN WEBRip x264-GalaxyTV            | no cumple      |
      | Demo S04E01 480p HDTV x264                            | no cumple      |
      | Demo S03E01 WEB-DL x264                               | cumple         |
      | Demo S03E01 HDTV x264-SOMEGROUP                       | cumple         |

  Scenario Outline: Con el mínimo en "cualquiera" no se descarta nada
    Given la calidad mínima es "cualquiera"
    When evalúo la calidad del release "<release>"
    Then el release "cumple"

    Examples:
      | release                                        |
      | Demo.S03.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV |
      | Demo S04E01 480p HDTV x264                       |
