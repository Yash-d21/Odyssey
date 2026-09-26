# Odyssey

Odyssey reviews a website from a single link. A real browser opens the page, walks a few same-site links, and writes two reports: one for design, and one for whether the page and its controls work.

Paste a link on the start screen. The agent’s browser appears on the page, with a live log of what it is doing. When the run finishes, the written report stays in the left history, and both PDFs can be downloaded from there.

## Run it

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npx playwright install chromium
npm start
```

Open [http://localhost:4173](http://localhost:4173).

The hosted copy is at [https://odyssey-six-lyart.vercel.app](https://odyssey-six-lyart.vercel.app). On Vercel the agent runs headless, a run has about a minute, and saved history lives only while that server instance is warm. `npm start` on your computer keeps the desktop browser and the saved runs.

One audit runs at a time. Saved runs, screenshots, and PDFs stay in `data/`, which is not committed.

## What a run does

1. Opens Chromium on the link (a visible window when the machine allows it, otherwise headless).
2. Measures the page on desktop (1440×900), tablet (768×1024), and mobile (390×844), including after a scroll.
3. Clicks up to three safe same-site links. It skips logout, delete, checkout, payment, and similar actions.
4. Writes the on-screen report and two PDFs.

Design measurements come from the [ui-ux-audit](https://github.com/imYChaudhary22/ui-ux-audit) script (MIT), copied in `vendor/audit.js`. They cover contrast, tap targets, spacing, alignment, overflow, images, and related checks. Functional notes come from what the agent saw: page load, console errors, failed requests, and each click.

## Reports

| File | What it contains |
| --- | --- |
| Design PDF | Visual and accessibility findings, plus landing and measurement screenshots |
| Testing PDF | Whether the page loaded and each clicked control responded, plus functional findings |

History keeps the latest 30 runs. **New run** returns to the centered link field.

## Project layout

| Path | Role |
| --- | --- |
| `server.js` | Serves the site and the run API |
| `agent.js` | Browser walk and findings |
| `pdfs.js` | Design and testing PDFs |
| `public/` | The site |
| `vendor/audit.js` | Measurement script from ui-ux-audit |

## License

The measurement script in `vendor/` is MIT, copyright 2026 imYChaudhary22. See `vendor/LICENSE-ui-ux-audit.txt`.
