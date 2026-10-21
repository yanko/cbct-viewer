# CBCT Viewer

A desktop app for viewing dental **CBCT / CT DICOM scans** on your own computer.
It's built with [Tauri 2](https://v2.tauri.app), React 19 and Vite 8, around the
open-source [`dental-cbct-viewer`](https://github.com/ZoliQua/Dental-CBCT-Viewer)
(DenCT) component. Scans are processed locally and never uploaded.

> [!NOTE]
> This project was built with AI: the code, tests and documentation were written by
> [Claude Code](https://claude.com/claude-code) (Anthropic). See [Built with AI](#built-with-ai).

> [!WARNING]
> This is research/demonstration software. It is **not** a certified medical
> device and must not be used for diagnosis, treatment planning or precise
> measurement. Gray values from CBCT scanners are uncalibrated, so HU and
> bone-density readings are only indicative.

## Features

- Axial, sagittal and coronal MPR with linked crosshairs, plus true-3D volume rendering
- Panoramic (OPG) reconstruction, cross-sections, measurements and implant planning (from DenCT)
- Opens DICOM folders, `.dcm` files, GALILEOS and OneVolume/Morita exports
- **Multi-frame volumes**: exports that store the whole scan in one file, such as
  Sirona ORTHOPHOS / Sidexis ("X-Ray 3D Craniofacial Image"), are split into
  slices automatically. DenCT on its own would show them as a single image.
- Fully offline, with a strict Content Security Policy and no network access

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 20.19+ or 22.12+
- [Rust](https://www.rust-lang.org/tools/install) (stable, 1.85+)
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
  (on Windows 11 the WebView2 runtime is already installed)

### Run

```bash
npm install
npm run tauri dev
```

### Build installers

```bash
npm run tauri build
```

The installers end up in `src-tauri/target/release/bundle/` (MSI and NSIS on Windows).

### Releases (Windows, macOS, Linux)

The [Release workflow](.github/workflows/release.yml) builds installers on GitHub Actions:

| Platform              | Installers                  |
| --------------------- | --------------------------- |
| Windows x64           | `.msi`, `-setup.exe` (NSIS) |
| macOS (Apple Silicon) | `.dmg`                      |
| macOS (Intel)         | `.dmg`                      |
| Linux x64             | `.deb`, `.rpm`, `.AppImage` |

To publish a release:

1. Set the same new version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. When the workflow finishes, review the **draft release** it created on GitHub and publish it.

Running the workflow manually (Actions → Release → Run workflow) builds the same
installers as downloadable workflow artifacts, without creating a release.

The builds aren't code-signed:

- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway**.
- **macOS:** Gatekeeper blocks the first launch. Right-click the app and choose **Open**, or run
  `xattr -cr "/Applications/CBCT Viewer.app"`.

## Opening a scan

1. Copy the scan from the clinic's CD/USB/download to your computer.
2. Click **Choose folder** and select the export's top folder. Subfolders are searched,
   so it can be e.g. `DICOM`, `DICOMRM` or the folder you downloaded.
3. Alternatively, click **Choose files** to pick `.dcm` files, or drop a folder on the drop zone.

Loading a few hundred MB takes a few seconds.

The **Load CT sample** buttons on the start screen don't work: DenCT's sample
data isn't included in its npm package.

## Development

| Command               | What it does                                             |
| --------------------- | -------------------------------------------------------- |
| `npm run tauri dev`   | Run the desktop app with hot reload                      |
| `npm run tauri build` | Release build and installers                             |
| `npm run dev`         | Frontend only, in a browser at <http://localhost:1420>   |
| `npm run check`       | Typecheck, lint, format check and tests (also run in CI) |
| `npm test`            | Unit tests (Vitest)                                      |
| `npm run format`      | Format with Prettier                                     |

Rust checks: `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` in `src-tauri/`.

### Project structure

```
src/
  App.tsx                          Full-window DenCT viewer
  dicom/
    splitMultiFrame.ts             Splits multi-frame DICOM volumes into single-frame CT slices
    splitMultiFrame.test.ts        Tests with synthetic DICOM data
    useDicomFileInterception.ts    Routes the viewer's file pickers / drop zone through the splitter
src-tauri/
  tauri.conf.json                  Window, CSP and cross-origin isolation headers
  src/lib.rs                       Tauri entry point (no custom commands)
vite.config.ts                     Dev/build config, incl. the DenCT worker-asset plugin
```

### How DenCT is integrated

DenCT has a few host requirements. Here's how each is handled:

| Requirement                                                                           | Where                                                                                                 |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Cross-origin isolation (COOP/COEP), so the decode workers can use `SharedArrayBuffer` | `app.security.headers` in `tauri.conf.json`; `server.headers` / `preview.headers` in `vite.config.ts` |
| CSP allowing `'wasm-unsafe-eval'` and `blob:` workers                                 | `app.security.csp` / `devCsp` in `tauri.conf.json`                                                    |
| Decode worker loaded from the absolute URL `/assets/decodeImageFrameWorker-*.js`      | The `dentalCbctWorkerAssets` plugin in `vite.config.ts` serves it in dev and copies it into the build |
| HTML5 drag & drop of folders                                                          | `dragDropEnabled: false` on the window, so Tauri doesn't intercept drops                              |
| Multi-frame volumes, which DenCT 1.4.0 treats as a single image                       | `src/dicom/`. See below.                                                                              |

#### Multi-frame DICOM

Some scanners store the entire volume as one enhanced multi-frame DICOM file.
`useDicomFileInterception` catches the viewer's DICOM pickers and drop zone in
the capture phase, and `expandMultiFrameDicom` then:

- **Splits volumes:** each multi-frame volume becomes single-frame CT images. Per-frame
  position, orientation, spacing, window and rescale are taken from the functional groups.
- **Adds the HU offset when it's missing:** unsigned data without a rescale gets the
  conventional −1024 HU intercept, because the viewer's 3D presets expect Hounsfield units.
- **Drops non-slices:** screenshots (Secondary Capture) and raw-data objects exported
  next to a split volume are left out.

The result is loaded through DenCT's public `loadStudy()` API. Compressed
multi-frame volumes aren't supported yet, and loading one shows an error.
STL and plan imports aren't affected.

## Privacy

Everything runs locally. The app makes no network requests (`connect-src` is
limited to the app itself), and your files are never modified. Splitting
happens in memory. `.gitignore` excludes `*.dcm` files and a `scans/` folder
so test data isn't committed by accident.

## Built with AI

This app was developed with [Claude Code](https://claude.com/claude-code), Anthropic's
AI coding agent. Claude wrote the code, configuration, tests and documentation, and
diagnosed the multi-frame DICOM issue using a real scanner export. Commits that Claude
contributed to carry a `Co-Authored-By: Claude` trailer.

Like any code, it may contain mistakes. Review it before relying on it, and keep the
medical disclaimer above in mind.

## License

[MIT](LICENSE). DenCT (`dental-cbct-viewer`) is MIT-licensed by Zoltán Dul, and it
depends on Cornerstone3D, vtk.js and other open-source libraries under their own licenses.
