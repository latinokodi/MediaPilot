@echo off
setlocal
cd /d "%~dp0"
title MediaPilot

set "SOLO_COMPROBAR="
if /i "%~1"=="check" set "SOLO_COMPROBAR=1"

echo.
echo   MediaPilot
echo   ==========
echo.
if defined SOLO_COMPROBAR echo   Modo comprobacion: solo revisa las dependencias.
echo.

:: ── 1/4 · Node.js ────────────────────────────────────────────────────────────
echo   [1/4] Node.js
call :hay node
if not errorlevel 1 goto node_ok
echo         no esta instalado.
call :instalar "OpenJS.NodeJS.LTS" "Node.js LTS"
call :refrescar_path
call :hay node
if errorlevel 1 (
  echo.
  echo   [!] No se pudo instalar Node.js automaticamente.
  echo       Descargalo de https://nodejs.org ^(version LTS^) y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
:node_ok
for /f "delims=" %%v in ('node --version 2^>nul') do echo         instalado: %%v

:: ── 2/4 · Python ─────────────────────────────────────────────────────────────
echo   [2/4] Python
set "PY="
call :hay py
if not errorlevel 1 set "PY=py -3"
if defined PY goto py_ok
call :hay python
if not errorlevel 1 set "PY=python"
if defined PY goto py_ok
echo         no esta instalado.
call :instalar "Python.Python.3.12" "Python 3.12"
call :refrescar_path
call :hay py
if not errorlevel 1 set "PY=py -3"
if defined PY goto py_ok
call :hay python
if not errorlevel 1 set "PY=python"
if defined PY goto py_ok
echo.
echo   [!] Sin Python no funciona la busqueda de titulos.
echo       Descargalo de https://www.python.org/downloads y vuelve a ejecutar este archivo.
echo.
pause
exit /b 1
:py_ok
for /f "delims=" %%v in ('%PY% --version 2^>^&1') do echo         instalado: %%v

:: ── 3/4 · FFmpeg (opcional) ──────────────────────────────────────────────────
echo   [3/4] FFmpeg ^(opcional^)
call :hay ffmpeg
if not errorlevel 1 goto ffmpeg_fin
echo         no esta instalado. Se usa para ordenar las pistas de audio y para
echo         comprobar la duracion antes de descargar.
choice /c SN /n /m "         Instalarlo ahora con winget? [S/N] "
if errorlevel 2 (
  echo         Se omite: la app funciona, pero sin post-proceso de audio.
  goto ffmpeg_fin
)
call :instalar "Gyan.FFmpeg" "FFmpeg"
call :refrescar_path
call :hay ffmpeg
if errorlevel 1 (
  echo         [!] No se pudo instalar. La app funcionara, pero sin post-proceso.
  goto ffmpeg_fin
)
echo         instalado.
:ffmpeg_fin

:: ── 4/4 · La aplicacion ──────────────────────────────────────────────────────
echo   [4/4] MediaPilot
if defined SOLO_COMPROBAR goto solo_check

if not exist "node_modules" (
  echo         instalando dependencias ^(solo la primera vez, tarda unos minutos^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo   [!] Fallo npm install. Revisa tu conexion y vuelve a intentarlo.
    pause
    exit /b 1
  )
) else (
  echo         dependencias: ya instaladas.
)

if not exist "dist\index.html" (
  echo         compilando...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   [!] Fallo la compilacion.
    pause
    exit /b 1
  )
) else (
  echo         compilado. Si actualizaste el codigo, borra la carpeta dist para recompilar.
)

echo         arrancando...
echo.
taskkill /f /im electron.exe >nul 2>&1
rem Modo desarrollo: es el que usa Python directamente para los motores de
rem busqueda, sin necesidad de compilar los ejecutables con PyInstaller.
call npm run electron:dev
echo.
echo   MediaPilot se ha cerrado.
pause
exit /b 0

:solo_check
echo.
echo   Todo listo. Ejecuta este archivo sin argumentos para arrancar la aplicacion.
echo.
pause
exit /b 0

:: ── Subrutinas ───────────────────────────────────────────────────────────────

:hay
where %~1 >nul 2>&1
exit /b %errorlevel%

:instalar
where winget >nul 2>&1
if errorlevel 1 (
  echo         [!] winget no esta disponible en este equipo: habria que instalarlo a mano.
  exit /b 1
)
echo         instalando con winget: %~2 ...
winget install -e --id %~1 --accept-source-agreements --accept-package-agreements --silent
exit /b %errorlevel%

:refrescar_path
rem winget actualiza el PATH del usuario, pero esta consola ya lo leyo al abrirse:
rem se vuelve a leer del registro para poder usar lo recien instalado sin cerrarla.
for /f "usebackq tokens=2,*" %%a in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "PATH_USUARIO=%%b"
if defined PATH_USUARIO set "PATH=%PATH_USUARIO%;%PATH%"
exit /b 0
