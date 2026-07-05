import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const FALLBACK_FONTS = ['sans-serif', 'serif', 'monospace']

let cache: string[] | null = null

/** Linux/mac: семейства через fontconfig. */
async function listFontconfig(): Promise<string[]> {
  const { stdout } = await execFileP('fc-list', [':', 'family'], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    // fc-list может отдавать несколько имён через запятую — берём первое.
    const family = line.split(',')[0]?.trim()
    if (family) out.push(family)
  }
  return out
}

/** Windows: семейства через .NET System.Drawing (есть в любой системе). */
async function listWindows(): Promise<string[]> {
  const { stdout } = await execFileP(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Drawing; ' +
        '[System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }',
    ],
    { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  )
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Список семейств шрифтов: fontconfig на Linux/mac, PowerShell на Windows.
 * Любая ошибка — базовый фолбэк; UI это переживает.
 */
export async function listFontFamilies(): Promise<string[]> {
  if (cache) return cache
  try {
    const found = process.platform === 'win32' ? await listWindows() : await listFontconfig()
    const families = new Set<string>([...FALLBACK_FONTS, ...found])
    cache = [...families].sort((a, b) => a.localeCompare(b, 'ru'))
  } catch {
    cache = [...FALLBACK_FONTS]
  }
  return cache
}
