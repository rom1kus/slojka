import { app, net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Протокол slojka-res:// — локальная раздача больших статических ресурсов
 * в renderer (сейчас: модели ONNX и wasm пакета @imgly/background-removal-data
 * для удаления фона). CDN не используется: всё работает офлайн.
 */

/** Обязан вызываться до app.whenReady(). */
export function registerResScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'slojka-res',
      privileges: { standard: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

/** Каталог данных @imgly (модели + wasm): prod — extraResources, dev — node_modules. */
function imglyDir(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'imgly')]
    : [
        // npm workspaces хостит пакет в корне монорепо; на всякий случай
        // проверяем и node_modules самого workspace.
        join(app.getAppPath(), '../../node_modules/@imgly/background-removal-data/dist'),
        join(app.getAppPath(), 'node_modules/@imgly/background-removal-data/dist'),
      ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Вызывается после app.whenReady(). */
export function registerResProtocol(): void {
  protocol.handle('slojka-res', async (req) => {
    const url = new URL(req.url)
    if (url.host !== 'imgly') return new Response('not found', { status: 404 })
    const dir = imglyDir()
    if (!dir) return new Response('imgly data not installed', { status: 404 })

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = normalize(join(dir, rel))
    // Защита от выхода из каталога через "..".
    if (file !== dir && !file.startsWith(normalize(dir) + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    if (!existsSync(file)) return new Response('not found', { status: 404 })

    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    // fetch() из renderer (в т.ч. из worker) — разрешаем любой origin.
    headers.set('access-control-allow-origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })
}
