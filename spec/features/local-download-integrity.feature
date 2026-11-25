@b26 @worker
Feature: Integridad de las descargas locales
  Tres fallos del worker dejaban la cola parada y episodios sin entrar: exigía
  un tamaño byte a byte, no detectaba conexiones muertas y no volvía a poner en
  cola lo que quedó a medias al reiniciar.

  Scenario: Un tamaño idéntico se acepta
    Given un archivo descargado de 2147483648 bytes
    And el tamaño esperado es 2147483648 bytes
    Then el tamaño se acepta

  Scenario: Unos pocos KB de diferencia no invalidan la descarga
    Given un archivo descargado de 2147483648 bytes
    And el tamaño esperado es 2147483000 bytes
    Then el tamaño se acepta

  Scenario: Un archivo a medias sí se rechaza
    Given un archivo descargado de 500000000 bytes
    And el tamaño esperado es 2147483648 bytes
    Then el tamaño se rechaza

  Scenario: Sin tamaño esperado no se juzga
    Given un archivo descargado de 12345 bytes
    And el tamaño esperado es 0 bytes
    Then el tamaño se acepta

  Scenario: Una descarga a medias se reanuda al arrancar
    Then el estado local "Downloading 2/3 (45%)" se reanuda

  Scenario: Una fila en cola se reanuda al arrancar
    Then el estado local "queued" se reanuda

  Scenario: Un fallo de verificación se reintenta al arrancar
    Then el estado local "failed: Failed to verify x.mkv: expected 100, got 90" se reanuda

  Scenario: Una descarga terminada no se reanuda
    Then el estado local "completed" no se reanuda

  Scenario: Un fallo del release no se reintenta solo
    Then el estado local "failed: torrent sin archivo de video" no se reanuda

  Scenario: Una conexión sin datos durante dos minutos está muerta
    Given la última actividad fue hace 130 segundos
    Then la descarga está atascada

  Scenario: Una conexión que acaba de recibir datos sigue viva
    Given la última actividad fue hace 10 segundos
    Then la descarga no está atascada
