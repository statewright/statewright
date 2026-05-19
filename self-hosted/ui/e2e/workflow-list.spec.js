import { test, expect } from '@playwright/test'

const PB_URL = process.env.PB_URL || 'http://localhost:8090'

test.describe('Workflow List', () => {
  // Clean up workflows created during tests
  test.afterEach(async ({ request }) => {
    try {
      const resp = await request.fetch(`${PB_URL}/api/collections/workflows/records`, {
        params: { filter: 'name ~ "e2e-"' },
      })
      if (!resp.ok()) return
      const data = await resp.json()
      for (const wf of data.items || []) {
        await request.delete(`${PB_URL}/api/collections/workflows/records/${wf.id}`)
      }
    } catch {
      // Best-effort cleanup
    }
  })

  test('workflow list page loads', async ({ page }) => {
    await page.goto('/workflows')
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible()
  })

  test('shows empty state when no workflows', async ({ page }) => {
    await page.goto('/workflows')
    await expect(page.getByText('No workflows yet')).toBeVisible()
  })

  test('new workflow button navigates to editor', async ({ page }) => {
    await page.goto('/workflows')
    await page.getByRole('button', { name: 'New Workflow' }).click()
    await expect(page).toHaveURL('/workflows/new')
  })

  test('template panel toggles', async ({ page }) => {
    await page.goto('/workflows')
    const templateBtn = page.getByRole('button', { name: 'From Template' })
    await templateBtn.click()
    // Template section should appear (or be empty if no templates seeded)
    await expect(page.getByRole('button', { name: 'Hide Templates' })).toBeVisible()
    await page.getByRole('button', { name: 'Hide Templates' }).click()
    await expect(templateBtn).toBeVisible()
  })

  test('JSON import panel toggles and validates', async ({ page }) => {
    await page.goto('/workflows')
    await page.getByRole('button', { name: 'From JSON' }).click()
    await expect(page.getByPlaceholder('{"id":')).toBeVisible()

    // Invalid JSON shows error
    await page.getByPlaceholder('{"id":').fill('not json')
    await page.getByRole('button', { name: 'Import' }).click()
    await expect(page.locator('.text-red-400')).toBeVisible()
  })

  test('JSON import creates workflow and navigates to editor', async ({ page }) => {
    await page.goto('/workflows')
    await page.getByRole('button', { name: 'From JSON' }).click()

    const def = JSON.stringify({
      id: 'e2e-import-test',
      initial: 'start',
      states: {
        start: { allowed_tools: ['Read'], on: { DONE: 'end' } },
        end: { type: 'final' },
      },
    })
    await page.getByPlaceholder('{"id":').fill(def)
    await page.getByRole('button', { name: 'Import' }).click()
    await expect(page).toHaveURL(/\/workflows\/[a-z0-9]+/)
  })

  test('workflow appears in list after creation', async ({ request, page }) => {
    // Create via API
    const resp = await request.post(`${PB_URL}/api/collections/workflows/records`, {
      data: {
        name: 'e2e-list-test',
        definition: { id: 'e2e-list-test', initial: 'start', states: { start: { on: { DONE: 'end' } }, end: { type: 'final' } } },
        active: false,
      },
    })
    expect(resp.ok()).toBeTruthy()

    await page.goto('/workflows')
    await expect(page.getByText('e2e-list-test')).toBeVisible()
  })

  test('delete workflow removes it from list', async ({ request, page }) => {
    // Create via API
    await request.post(`${PB_URL}/api/collections/workflows/records`, {
      data: {
        name: 'e2e-delete-test',
        definition: { id: 'e2e-delete-test', initial: 'a', states: { a: { type: 'final' } } },
        active: false,
      },
    })

    await page.goto('/workflows')
    await expect(page.getByText('e2e-delete-test')).toBeVisible()

    // Delete
    page.on('dialog', dialog => dialog.accept())
    await page.getByText('e2e-delete-test').locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText('e2e-delete-test')).not.toBeVisible()
  })
})
