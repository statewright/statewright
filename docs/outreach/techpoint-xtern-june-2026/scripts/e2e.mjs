import assert from 'node:assert/strict';

let chromium;

try {
  const moduleName = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
  ({ chromium } = await import(moduleName));
} catch {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(1);
}

const baseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4317';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];

page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') {
    errors.push(message.text());
  }
});

try {
  const [summaryResponse, incidentsResponse, timelineResponse, eventsResponse] = await Promise.all([
    page.waitForResponse(`${baseUrl}/api/summary`),
    page.waitForResponse(`${baseUrl}/api/incidents`),
    page.waitForResponse(`${baseUrl}/api/timeline`),
    page.waitForResponse(`${baseUrl}/api/events`),
    page.goto(baseUrl),
  ]);

  assert.equal(summaryResponse.status(), 200);
  assert.equal(incidentsResponse.status(), 200);
  assert.equal(timelineResponse.status(), 200);
  assert.equal(eventsResponse.status(), 200);

  await page.getByRole('heading', { name: 'Incident Signal Dashboard' }).waitFor();
  await page.getByText('Total events').waitFor();
  await page.getByText('Open incidents').waitFor();
  await page.getByText('Incident Queue').waitFor();
  await page.getByText('Hourly Risk').waitFor();
  await page.getByText('Security Event Readout').waitFor();
  await page.getByText('Source Coverage').waitFor();
  await page.getByText('CrowdStrike').first().waitFor();

  const totalEvents = await page.locator('article').filter({ hasText: 'Total events' }).textContent();
  assert.match(totalEvents ?? '', /12/);

  const openIncidents = await page.locator('article').filter({ hasText: 'Open incidents' }).textContent();
  assert.match(openIncidents ?? '', /5/);
  assert.equal(await page.locator('.incident').count(), 5);
  assert.equal(await page.getByText('unassigned entity').count(), 0);

  await page.getByPlaceholder('Search entity, vendor, action').fill('rwy');
  await page.getByRole('button', { name: 'critical', exact: true }).click();
  await page.getByText('Selected Incident').waitFor();
  await page.getByRole('button', { name: 'all', exact: true }).click();
  await page.getByPlaceholder('Search entity, vendor, action').fill('');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

console.log('E2E dashboard smoke test passed.');
