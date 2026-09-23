// resource-paths.ts — dónde está de verdad un script o un motor.
//
// La app empaquetada los tiene en sus recursos (process.resourcesPath). Al
// ejecutarla desde el código, esa carpeta es node_modules/electron/dist/resources
// y ahí no hay ningún .py ni ningún motor: la app buscaba tmdb-provider.py
// dentro de Electron y fallaba con
//   can't open file ...node_modules/electron/dist/resources/tmdb-provider.py
//
// Aquí se prueban los sitios posibles (recursos, raíz del proyecto y la carpeta
// electron/ del proyecto) y se devuelve el primero que exista.
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

function candidatos(partes: string[]): string[] {
  const raiz = (() => {
    try {
      return app.getAppPath()
    } catch {
      return ''
    }
  })()
  return [
    process.resourcesPath ? path.join(process.resourcesPath, ...partes) : '',
    raiz ? path.join(raiz, ...partes) : '',
    raiz ? path.join(raiz, 'electron', ...partes) : '',
    path.join(__dirname, '..', ...partes),
    path.join(__dirname, '..', 'electron', ...partes),
  ].filter(Boolean)
}

export function existeRuta(p: string): boolean {
  if (!p) return false
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** Primera ruta existente de las posibles (o la primera, para que el error diga algo útil). */
export function rutaDeRecurso(...partes: string[]): string {
  const lista = candidatos(partes)
  for (const c of lista) {
    if (existeRuta(c)) return c
  }
  return lista[0] || path.join(...partes)
}
