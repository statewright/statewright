import { test, expect } from '@playwright/test'

const PB_URL = process.env.PB_URL || 'http://localhost:8090'

test.describe('Workflow Runs', () => {
  test.afterEach(async ({ request }) => {
    try {
      const resp = await request.fetch(`${PB_URL}/api/collections/workflow_runs/records`, {
        params: { filter: 'workflow_name ~ "e2e-"' },
      })
      if (!resp.ok()) return
      const data = await resp.json()
      for (const run of data.items || []) {
        await request.delete(`${PB_URL}/api/collections/workflow_runs/records/${run.id}`)
      }
    } catch {}
  })

  test('runs page loads with heading', async ({ page }) => {
    await page.goto('/runs')
    await expect(page.getByRole('heading', { name: 'Run History' })).toBeVisible()
  })

  test('shows empty state when no runs', async ({ page }) => {
    await page.goto('/runs')
    await expect(page.getByText('No workflow runs yet')).toBeVisible()
    await expect(page.getByText('Activate a workflow via the gateway')).toBeVisible()
  })

  test('workflows link navigates back', async ({ page }) => {
    await page.goto('/runs')
    await page.getByRole('link', { name: /Workflows/ }).click()
    await expect(page).toHaveURL('/workflows')
  })

  test('run appears in list when created via API', async ({ request, page }) => {
    await request.post(`${PB_URL}/api/collections/workflow_runs/records`, {
      data: {
        workflow_name: 'e2e-run-test',
        status: 'completed',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        transition_count: 3,
        transitions: JSON.stringify([
          { from: 'planning', to: 'implementing', event: 'READY', timestamp: new Date().toISOString() },
          { from: 'implementing', to: 'testing', event: 'DONE', timestamp: new Date().toISOString() },
          { from: 'testing', to: 'completed', event: 'PASS', timestamp: new Date().toISOString() },
        ]),
      },
    })

    await page.goto('/runs')
    await expect(page.getByText('e2e-run-test')).toBeVisible()
    await expect(page.getByText('completed')).toBeVisible()
    await expect(page.getByText('3 transitions')).toBeVisible()
  })

  test('clicking run expands transition timeline', async ({ request, page }) => {
    await request.post(`${PB_URL}/api/collections/workflow_runs/records`, {
      data: {
        workflow_name: 'e2e-expand-test',
        status: 'completed',
        started_at: new Date().toISOString(),
        transition_count: 2,
        transitions: JSON.stringify([
          { from: 'planning', to: 'implementing', event: 'READY', timestamp: new Date().toISOString() },
          { from: 'implementing', to: 'completed', event: 'DONE', timestamp: new Date().toISOString() },
        ]),
      },
    })

    await page.goto('/runs')
    // Click the expand arrow
    await page.getByText('e2e-expand-test').locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').locator('button').first().click()

    // Transition timeline should be visible
    await expect(page.getByText('planning')).toBeVisible()
    await expect(page.getByText('implementing')).toBeVisible()
    await expect(page.getByText('READY')).toBeVisible()
    await expect(page.getByText('DONE')).toBeVisible()
  })

  test('run status badges render correctly', async ({ request, page }) => {
    // Create runs with different statuses
    for (const status of ['running', 'completed', 'failed', 'stopped']) {
      await request.post(`${PB_URL}/api/collections/workflow_runs/records`, {
        data: {
          workflow_name: `e2e-status-${status}`,
          status,
          started_at: new Date().toISOString(),
          transition_count: 0,
          transitions: '[]',
        },
      })
    }

    await page.goto('/runs')
    await expect(page.getByText('running')).toBeVisible()
    await expect(page.getByText('completed')).toBeVisible()
    await expect(page.getByText('failed')).toBeVisible()
    await expect(page.getByText('stopped')).toBeVisible()
  })

  test('rationale displays in transition timeline', async ({ request, page }) => {
    await request.post(`${PB_URL}/api/collections/workflow_runs/records`, {
      data: {
        workflow_name: 'e2e-rationale-test',
        status: 'completed',
        started_at: new Date().toISOString(),
        transition_count: 1,
        transitions: JSON.stringify([
          { from: 'planning', to: 'implementing', event: 'READY', timestamp: new Date().toISOString(), data: { rationale: 'Found the root cause in auth module' } },
        ]),
      },
    })

    await page.goto('/runs')
    await page.getByText('e2e-rationale-test').locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').locator('button').first().click()
    await expect(page.getByText('Found the root cause in auth module')).toBeVisible()
  })

  test('collapse expanded run hides timeline', async ({ request, page }) => {
    await request.post(`${PB_URL}/api/collections/workflow_runs/records`, {
      data: {
        workflow_name: 'e2e-collapse-test',
        status: 'running',
        started_at: new Date().toISOString(),
        transition_count: 1,
        transitions: JSON.stringify([
          { from: 'planning', to: 'implementing', event: 'READY', timestamp: new Date().toISOString() },
        ]),
      },
    })

    await page.goto('/runs')
    const runRow = page.getByText('e2e-collapse-test').locator('xpath=ancestor::div[contains(@class,"rounded-lg")]')
    const expandBtn = runRow.locator('button').first()

    // Expand
    await expandBtn.click()
    await expect(page.getByText('READY')).toBeVisible()

    // Collapse
    await expandBtn.click()
    // The transition event text should no longer be visible in the timeline
    // (it might still be in the status area, so check the timeline container specifically)
    await expect(page.locator('.border-brand-500\\/30')).not.toBeVisible()
  })
})
