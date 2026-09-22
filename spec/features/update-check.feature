# B21 · Actualizaciones y guardado de ajustes que no asustan ni pierden datos
#
# ← dos fallos reales reportados por un usuario de la versión publicada:
#   1) un error de actualización mostrado en pantalla que sólo significaba
#      «no hay nada nuevo publicado» (el CI borraba y recreaba el release, así
#      que durante unos segundos el repositorio no tenía ninguna versión);
#   2) «Error occurred in handler for 'set-settings'» y ajustes que no se
#      guardaban: el UPDATE se construía con las claves recibidas sin comprobar
#      que fuesen columnas reales ni que el valor fuese enlazable por SQLite.

@b21
Feature: La app no muestra errores inofensivos ni pierde ajustes

  Scenario Outline: lo que sólo significa «no hay nada nuevo» no es un fallo
    Given el error de actualización "<mensaje>" es leve
    Then la app lo trata como sin actualización y no lo enseña como error

    Examples:
      | mensaje                                        |
      | No published versions on GitHub                |
      | getaddrinfo ENOTFOUND api.github.com           |
      | connect ETIMEDOUT 140.82.121.6:443             |
      | net::ERR_INTERNET_DISCONNECTED                 |
      | HttpError: 404 Not Found                       |
      | HttpError: 503 Service Unavailable             |

  Scenario Outline: un fallo de verdad sigue siendo un fallo
    Given el error de actualización "<mensaje>" no es leve
    Then la app lo trata como sin actualización y no lo enseña como error

    Examples:
      | mensaje                                                     |
      | sha512 checksum mismatch                                     |
      | EPERM: operation not permitted, rename 'latest.yml'          |
      | Cannot find module 'app-update.yml'                          |
      | Error: no write access to C:\Program Files\MediaPilot        |

  Scenario: una clave que no es columna no rompe el guardado
    # ← el fallo reportado: saltaba la sentencia entera y no se guardaba nada
    Given recuerdo el ajuste "language_profile"
    When guardo ajustes con la clave "clave_que_no_existe" y el valor "x"
    Then el guardado se acepta
    And el guardado aplica 0 campos
    And el guardado ignora "clave_que_no_existe"
    And el ajuste "language_profile" sigue como estaba

  Scenario: un valor que SQLite no sabe enlazar se convierte en JSON
    Given recuerdo el ajuste "last_update_prompt"
    When guardo ajustes con la clave "last_update_prompt" y un objeto
    Then el guardado se acepta
    And el ajuste "last_update_prompt" se guardó como JSON
    And restauro el ajuste "last_update_prompt"

  Scenario: un ajuste válido se guarda y se lee igual
    Given recuerdo el ajuste "language_profile"
    When guardo ajustes con la clave "language_profile" y el valor "latino_only"
    Then el ajuste "language_profile" vale "latino_only"
    And restauro el ajuste "language_profile"
  Scenario: el identificador de la fila no se reporta como ignorado
    # ← el frontend manda el objeto de ajustes completo; 'id' se salta a
    # propósito y no debe aparecer como aviso en los registros
    When guardo ajustes con la clave "id" y el valor "1"
    Then el guardado se acepta
    And el guardado aplica 0 campos
    And el guardado no reporta "id"
