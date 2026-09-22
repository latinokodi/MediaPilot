@echo off
setlocal
cd /d "%~dp0"
title MediaPilot

echo.
echo   MediaPilot
echo   ==========
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [!] No se encontro Node.js.
  echo       Instala la version LTS desde https://nodejs.org y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   [1/4] Instalando dependencias ^(solo la primera vez, tarda un poco^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo   [!] Fallo npm install. Revisa tu conexion y vuelve a intentarlo.
    pause
    exit /b 1
  )
) else (
  echo   [1/4] Dependencias: ya instaladas.
)

if not exist "dist\index.html" (
  echo   [2/4] Compilando MediaPilot...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   [!] Fallo la compilacion.
    pause
    exit /b 1
  )
) else (
  echo   [2/4] Compilado. Si actualizaste el codigo, borra la carpeta dist para recompilar.
)

if not exist "electron\qbit-runner.exe" (
  echo   [3/4] Aviso: faltan los motores de busqueda ^(electron\qbit-runner.exe^).
  echo         La app arrancara, pero la busqueda no devolvera resultados hasta que los
  echo         generes con:  npm run pyinstaller   ^(requiere Python y pyinstaller^)
) else (
  echo   [3/4] Motores de busqueda: listos.
)

echo   [4/4] Arrancando...
echo.
taskkill /f /im electron.exe >nul 2>&1
call npm start

echo.
echo   MediaPilot se ha cerrado.
pause
