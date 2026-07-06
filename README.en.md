# Slojka

**[Русская версия → README.md](README.md)**

An AI-first, Photoshop-style graphics editor: layers, masks, selections,
brushes — with native integration of local SAM 2.1 segmentation, the
polza.ai image-generation hub, and an AI assistant (Claude Code) that
drives the editor through MCP. UI languages: Russian (primary) and English.

![Slojka demo](demo.gif)

## Features

### Editor
- Layers: raster, text, and **smart layers** (lossless move, scale and
  rotate — content beyond the canvas edge is never lost).
- **Per-fragment text styles**: select part of the text and give it its
  own font, size, color and weight, just like in Photoshop.
- Layer masks, clipping masks, 8 blend modes.
- Flip a layer horizontally/vertically (right-click the layer) — around
  the content center, just like Photoshop.
- Selections: rectangle, ellipse, lasso, magic wand, selection brushes —
  with live feather and expand/contract sliders.
- Layer styles: drop/inner shadow, outer glow, **outer stroke**, color
  overlay, Gaussian blur, motion blur (follows the object's rotation).
  Stroke, glow and shadow spread are built from a Euclidean distance
  field — they extend evenly from the edge in every direction,
  corners included.
- Pressure-sensitive brushes and eraser; imports Krita (`.kpp`) and
  Photoshop (`.abr`) brushes.
- Crop tool and on-the-fly canvas resizing.
- Document tabs with drag-and-drop layer transfer, undo history with a
  configurable memory budget, autosave.

### Files
- Native `.slojka` format (zip, OpenRaster-style).
- PSD and ORA import; PNG / JPEG / WebP / ORA export.

### AI (all optional — the editor is fully functional without it)
- **Background removal**: right-click a layer → "Remove background" — a
  local neural network (ISNet, ONNX Runtime), fully offline, no Python
  needed, the model ships with the app. For smart layers the background
  is removed from the original (lossless transforms); undo with Ctrl+Z.
- **SAM 2.1**: click an object to get a clean selection or a layer mask.
  Runs locally (CUDA or CPU), no internet required.
- **polza.ai** (API key required): image generation (Nano Banana,
  Seedream, GPT Image, Flux, Grok, Qwen and more), upscaling, and
  selection-based "remove object" / "replace object" — results are
  inserted automatically as new layers. The "Photobash" 🎬 button
  flattens everything visible into one image and lets the model rebuild
  it into a coherent scene (unified lighting, camera, materials).
  The job queue survives restarts; per-job cost is displayed.
- **AI assistant**: a built-in terminal running Claude Code connected to
  the editor via MCP (27 tools). Ask in plain language — it selects,
  generates, paints and saves; every edit is undoable with Ctrl+Z.
- Prompt library with tags.

## Installation

### Prebuilt binaries
See the [Releases](../../releases) page:
- **Linux**: `Slojka-x.y.z.AppImage` — make it executable
  (`chmod +x`) and run;
- **Windows**: `Slojka-Setup-x.y.z.exe` — installer.

### From source
Requires Node.js ≥ 20.19.

```bash
git clone https://github.com/HelpFreedom/slojka.git
cd slojka
npm install
npm run dev        # development mode
```

Other commands:

```bash
npm run smoke      # build + smoke test (WebGL2 + engine self-tests)
npm run typecheck  # type checking
npm test           # unit tests
npm run audit      # dependency vulnerability audit
npm run dist       # build the AppImage (packages/app/release/)
npm run dist -- --win   # build the Windows installer
```

### Enabling the AI features
1. **Local AI (SAM 2.1)**: requires Python ≥ 3.10 (the Slojka Windows
   installer sets up Python 3.11 and the Microsoft VC++ Redistributable
   automatically if missing; on Linux install python3 with your package
   manager). Open ⚙ Settings → "Local AI" → "Enable" (~15 MB
   environment), then "Install SAM 2.1" (PyTorch, ~2.5 GB, downloaded
   only after explicit consent) and pick a model (from 156 MB).
   Everything lives in an isolated venv.
2. **Generation (polza.ai)**: paste your API key into the "AI generation"
   panel. The key is stored in the system keyring.
3. **AI assistant**: install [Claude Code](https://claude.com/claude-code)
   (`npm install -g @anthropic-ai/claude-code`) and press "🤖 AI assistant"
   in the status bar. If your network goes through a proxy, set it in
   ⚙ Settings → "Network".

## Keyboard shortcuts

B brush · E eraser · M/Shift+M marquee · L lasso · W magic wand ·
A AI select · T text · C crop · H hand · V move/transform ·
[ ] brush size · Space pan · Ctrl+Z/Shift+Z history ·
Ctrl+A select layer pixels · Ctrl+C/X/V copy/cut/paste as layer ·
Ctrl+J duplicate · Ctrl+E merge down · Ctrl+Shift+E merge visible ·
Ctrl+D deselect · Ctrl+Shift+I invert · Del clear · Ctrl+S save

Shortcuts are bound to physical keys — they work in any keyboard layout.

## Architecture

```
packages/shared      branding, document model, i18n (ru + en)
packages/engine      WebGL2 engine: compositor, brushes, selections, styles, history
packages/app         Electron: main / preload / renderer (React)
packages/mcp-server  MCP server for Claude Code
sidecar/             Python: SAM 2.1 + polza.ai client (optional)
```

A detailed technical description of every subsystem lives in
[TECHNICAL.md](TECHNICAL.md) (Russian).

## Platforms

Linux is the primary platform (tested on Debian 11+). The codebase is
cross-platform: Windows is supported (fonts, terminal, data paths and the
packager all have platform branches). Building the Windows installer on a
Linux machine requires wine.

## Authors

- **Black Triangle** — concept, task design, testing.
- **Claude** (Anthropic) — code.

## License

[GNU GPL v3](LICENSE) — free software: use, study, modify and
redistribute under the terms of the license.
