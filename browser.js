import { chromium } from 'playwright';

/**
 * Local runs use the Playwright browser. On Vercel that binary is missing
 * system libraries such as libnspr4, so the hosted agent uses the Sparticuz
 * build, which carries the libraries Amazon Linux needs.
 */
async function launchServerless() {
  const { default: packed } = await import('@sparticuz/chromium');
  packed.setGraphicsMode = false;
  return chromium.launch({
    args: packed.args,
    executablePath: await packed.executablePath(),
    headless: true,
  });
}

export async function launchAgentBrowser() {
  if (process.env.VERCEL) {
    return { browser: await launchServerless(), headed: false };
  }
  try {
    return {
      browser: await chromium.launch({
        headless: false,
        slowMo: 220,
        args: ['--window-position=80,60'],
      }),
      headed: true,
    };
  } catch {
    return { browser: await chromium.launch({ headless: true }), headed: false };
  }
}

export async function launchPdfBrowser() {
  if (process.env.VERCEL) return launchServerless();
  return chromium.launch({ headless: true });
}
