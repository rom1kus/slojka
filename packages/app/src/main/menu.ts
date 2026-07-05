import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { t, type Lang } from '@slojka/shared'

/**
 * Идентификаторы пунктов меню — renderer получает их через 'menu:action'
 * и решает, что делать. Main не знает о документе ничего.
 */
export type MenuActionId =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.export'
  | 'file.import'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.clear'
  | 'layer.flatten'
  | 'select.all'
  | 'select.deselect'
  | 'select.invert'
  | 'select.feather'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomFit'
  | 'view.zoomActual'
  | 'help.about'

export function buildMenu(win: BrowserWindow, lang: Lang): void {
  const send = (id: MenuActionId) => () => win.webContents.send('menu:action', id)
  const _ = (key: string) => t(lang, key)

  const template: MenuItemConstructorOptions[] = [
    {
      label: _('menu.file'),
      submenu: [
        { label: _('menu.new'), accelerator: 'CmdOrCtrl+N', click: send('file.new') },
        { label: _('menu.open'), accelerator: 'CmdOrCtrl+O', click: send('file.open') },
        { label: _('menu.import'), click: send('file.import') },
        { type: 'separator' },
        { label: _('menu.save'), accelerator: 'CmdOrCtrl+S', click: send('file.save') },
        { label: _('menu.saveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: send('file.saveAs') },
        { label: _('menu.export'), accelerator: 'CmdOrCtrl+Alt+S', click: send('file.export') },
        { type: 'separator' },
        { label: _('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: _('menu.edit'),
      submenu: [
        { label: _('menu.undo'), accelerator: 'CmdOrCtrl+Z', click: send('edit.undo') },
        { label: _('menu.redo'), accelerator: 'CmdOrCtrl+Shift+Z', click: send('edit.redo') },
        { type: 'separator' },
        // Без accelerator: Delete перехватывался бы и в полях ввода.
        // Хоткей Del обрабатывает renderer (с проверкой фокуса).
        { label: _('menu.clear'), click: send('edit.clear') },
      ],
    },
    {
      label: _('menu.layer'),
      submenu: [
        { label: _('menu.flatten'), accelerator: 'CmdOrCtrl+Shift+E', click: send('layer.flatten') },
      ],
    },
    {
      label: _('menu.selection'),
      submenu: [
        { label: _('menu.selectAll'), accelerator: 'CmdOrCtrl+A', click: send('select.all') },
        { label: _('menu.deselect'), accelerator: 'CmdOrCtrl+D', click: send('select.deselect') },
        {
          label: _('menu.invertSelection'),
          accelerator: 'CmdOrCtrl+Shift+I',
          click: send('select.invert'),
        },
        { type: 'separator' },
        { label: _('menu.feather'), accelerator: 'Shift+F6', click: send('select.feather') },
      ],
    },
    {
      label: _('menu.view'),
      submenu: [
        { label: _('menu.zoomIn'), accelerator: 'CmdOrCtrl+=', click: send('view.zoomIn') },
        { label: _('menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: send('view.zoomOut') },
        { label: _('menu.zoomFit'), accelerator: 'CmdOrCtrl+0', click: send('view.zoomFit') },
        { label: _('menu.zoomActual'), accelerator: 'CmdOrCtrl+1', click: send('view.zoomActual') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: _('menu.help'),
      submenu: [{ label: _('menu.about'), click: send('help.about') }],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
