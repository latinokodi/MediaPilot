// Parser mínimo de Gherkin (subconjunto suficiente para el spec de MediaPilot):
// Feature, Scenario, Scenario Outline + Examples, tags (@x), comentarios (#),
// tablas de datos en pasos y sustitución de <placeholders> en los outlines.
//
// Deliberadamente pequeño: no queremos arrastrar Cucumber para probar funciones
// de dominio; el .feature es la documentación viva y esto la ejecuta.

export interface Step {
  keyword: string
  text: string
  /** Filas de la tabla del paso, sin la cabecera. */
  rows: string[][]
}

export interface Scenario {
  feature: string
  name: string
  tags: string[]
  steps: Step[]
  /** Nº de fila del ejemplo (para los outlines). */
  exampleIndex?: number
}

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/<([^>]+)>/g, (_, key: string) => values[key.trim()] ?? '')
}

export function parseFeature(source: string, file: string): Scenario[] {
  const scenarios: Scenario[] = []
  let featureName = file
  let pendingTags: string[] = []
  let featureTags: string[] = []

  type Outline = { name: string; tags: string[]; steps: Step[]; outline: boolean }
  let current: Outline | null = null
  let examples: { header: string[]; rows: string[][] } | null = null
  let inExamples = false
  let currentStep: Step | null = null
  let stepHeaderSeen = false

  const flush = () => {
    if (!current) return
    const cur: Outline = current
    if (cur.outline && examples && examples.rows.length > 0) {
      examples.rows.forEach((row, i) => {
        const values: Record<string, string> = {}
        examples!.header.forEach((h, hi) => { values[h] = row[hi] ?? '' })
        scenarios.push({
          feature: featureName,
          name: `${cur.name} [${row.join(' · ')}]`,
          tags: [...featureTags, ...cur.tags],
          exampleIndex: i + 1,
          steps: cur.steps.map((s) => ({
            ...s,
            text: substitute(s.text, values),
            rows: s.rows.map((r) => r.map((c) => substitute(c, values))),
          })),
        })
      })
    } else {
      scenarios.push({ feature: featureName, name: cur.name, tags: [...featureTags, ...cur.tags], steps: cur.steps })
    }
    current = null
    examples = null
    inExamples = false
    currentStep = null
    stepHeaderSeen = false
  }

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('@')) {
      pendingTags = line.split(/\s+/).filter((t) => t.startsWith('@')).map((t) => t.toLowerCase())
      continue
    }
    if (/^Feature:/i.test(line)) {
      featureName = line.replace(/^Feature:/i, '').trim() || file
      featureTags = pendingTags
      pendingTags = []
      continue
    }
    if (/^Scenario Outline:/i.test(line) || /^Scenario:/i.test(line)) {
      flush()
      const outline = /^Scenario Outline:/i.test(line)
      const name = line.replace(/^Scenario( Outline)?:/i, '').trim()
      current = { name, tags: pendingTags, steps: [], outline }
      pendingTags = []
      continue
    }
    if (/^Examples:/i.test(line)) {
      examples = { header: [], rows: [] }
      inExamples = true
      currentStep = null
      continue
    }
    if (/^(Given|When|Then|And|But)\b/i.test(line)) {
      const m = line.match(/^(Given|When|Then|And|But)\s+(.*)$/i)!
      currentStep = { keyword: m[1], text: m[2].trim(), rows: [] }
      stepHeaderSeen = false
      inExamples = false
      current?.steps.push(currentStep)
      continue
    }
    if (line.startsWith('|')) {
      const row = parseRow(line)
      if (inExamples && examples) {
        if (examples.header.length === 0) examples.header = row
        else examples.rows.push(row)
        continue
      }
      if (currentStep) {
        // La primera fila de la tabla de un paso es la cabecera (no se usa).
        if (!stepHeaderSeen) stepHeaderSeen = true
        else currentStep.rows.push(row)
      }
    }
  }
  flush()
  return scenarios
}
