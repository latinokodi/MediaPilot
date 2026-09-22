// Runner de la spec ejecutable (BDD): lee spec/features/*.feature y ejecuta
// cada escenario contra los módulos reales de la app.
//
//   npm run spec                    # todo
//   npm run spec -- --skip=@network # sin red (TMDB)
//   npm run spec -- --feature=naming
//
// Sale con código 1 si algún escenario falla.
import fs from 'fs'
import path from 'path'
import { parseFeature, type Scenario } from './gherkin'
import { stepDefs, type World } from './steps'
import { initDB, getDB } from '../../electron/db'

const FEATURES_DIR = path.join(__dirname, '..', 'spec', 'features')

interface Result {
  scenario: Scenario
  status: 'passed' | 'failed'
  failedStep?: string
  error?: string
  skipped?: boolean
}

function argValue(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

async function runScenario(scenario: Scenario): Promise<Result> {
  const world: World = {}
  for (const step of scenario.steps) {
    const def = stepDefs.find((d) => d.pattern.test(step.text))
    if (!def) {
      return { scenario, status: 'failed', failedStep: step.text, error: 'paso sin definición en spec/support/steps.ts' }
    }
    const args = step.text.match(def.pattern)!.slice(1).filter((a) => a !== undefined) as string[]
    try {
      await def.fn({ world, scenarioName: scenario.name, rows: step.rows }, ...args)
    } catch (e: any) {
      return { scenario, status: 'failed', failedStep: step.text, error: e?.message || String(e) }
    }
  }
  if (world.root) fs.rmSync(world.root, { recursive: true, force: true })
  return { scenario, status: 'passed' }
}

async function main(): Promise<void> {
  const skip = (argValue('skip') || '').toLowerCase()
  const onlyFeature = (argValue('feature') || '').toLowerCase()

  // La resolución de carpetas escribe en media_folders: se restaura al final.
  initDB()
  const db = getDB()
  const snapshot = db.prepare('SELECT tmdb_id, media_type, folder FROM media_folders').all() as any[]

  const files = fs.readdirSync(FEATURES_DIR).filter((f) => f.endsWith('.feature')).sort()
  const results: Result[] = []
  let skippedCount = 0

  for (const file of files) {
    if (onlyFeature && !file.toLowerCase().includes(onlyFeature)) continue
    const source = fs.readFileSync(path.join(FEATURES_DIR, file), 'utf8')
    const scenarios = parseFeature(source, file)
    console.log(`\n\x1b[1m${file}\x1b[0m — ${scenarios.length} escenario(s)`)
    for (const scenario of scenarios) {
      const tags = scenario.tags.join(' ')
      if (skip && scenario.tags.includes(skip)) {
        skippedCount++
        console.log(`  \x1b[90m○ omitido (${skip}) — ${scenario.name}\x1b[0m`)
        continue
      }
      process.stdout.write(`  · ${scenario.name}${tags ? ` \x1b[90m(${tags})\x1b[0m` : ''} `)
      const res = await runScenario(scenario)
      results.push(res)
      if (res.status === 'passed') {
        console.log('\x1b[32mPASS\x1b[0m')
      } else {
        console.log('\x1b[31mFAIL\x1b[0m')
        console.log(`      paso: ${res.failedStep}`)
        console.log(`      ${String(res.error).split('\n').join('\n      ')}`)
      }
    }
  }

  db.prepare('DELETE FROM media_folders').run()
  const ins = db.prepare('INSERT INTO media_folders (tmdb_id, media_type, folder, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
  for (const r of snapshot) ins.run(r.tmdb_id, r.media_type, r.folder)

  const failed = results.filter((r) => r.status === 'failed')
  const passed = results.length - failed.length
  console.log(
    `\n${failed.length === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${results.length} escenarios OK\x1b[0m` +
    `${skippedCount ? ` · ${skippedCount} omitidos` : ''} · media_folders restaurado (${snapshot.length} filas)`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('runner crashed:', e)
  process.exit(2)
})
