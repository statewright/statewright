import { test, expect } from '@playwright/test'

const PB_URL = process.env.PB_URL || 'http://localhost:8090'

test.describe('Workflow Editor', () => {
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
    } catch {}
  })

  test('new workflow editor loads with default states', async ({ page }) => {
    await page.goto('/workflows/new')
    // Default workflow has planning, implementing, testing, completed, failed
    // Use exact match to avoid tooltip text ("READY → implementing")
    await expect(page.getByText('planning', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('implementing', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('testing', { exact: true }).first()).toBeVisible()
  })

  test('workflow name input is editable', async ({ page }) => {
    await page.goto('/workflows/new')
    const nameInput = page.locator('input[placeholder="Workflow name"]')
    await nameInput.fill('e2e-editor-test')
    await expect(nameInput).toHaveValue('e2e-editor-test')
  })

  test('add state button creates new node', async ({ page }) => {
    await page.goto('/workflows/new')
    // Wait for VueFlow to render default nodes
    await expect(page.locator('.vue-flow__node').first()).toBeVisible()
    const stateCount = await page.locator('.vue-flow__node').count()
    await page.getByRole('button', { name: '+ State' }).click()
    // New node should appear — use a generous timeout for VueFlow re-render
    await expect(page.locator('.vue-flow__node')).toHaveCount(stateCount + 1, { timeout: 5000 })
  })

  test('add final state button creates final node', async ({ page }) => {
    await page.goto('/workflows/new')
    await page.getByRole('button', { name: '+ Final' }).click()
    // Should see 'end' label for the new final state (end_1 if end already exists)
    await expect(page.locator('.state-node').last()).toBeVisible()
  })

  test('JSON view toggle shows definition', async ({ page }) => {
    await page.goto('/workflows/new')
    await page.getByRole('button', { name: 'View JSON' }).click()
    await expect(page.getByText('JSON Definition')).toBeVisible()
    // Should show valid indicator
    await expect(page.getByText('Valid')).toBeVisible()
  })

  test('JSON editor contains workflow states', async ({ page }) => {
    await page.goto('/workflows/new')
    await page.getByRole('button', { name: 'View JSON' }).click()
    const textarea = page.locator('textarea')
    const json = await textarea.inputValue()
    const def = JSON.parse(json)
    expect(def.initial).toBe('planning')
    expect(def.states).toHaveProperty('planning')
    expect(def.states).toHaveProperty('implementing')
    expect(def.states).toHaveProperty('testing')
  })

  test('clicking a node opens properties sidebar', async ({ page }) => {
    await page.goto('/workflows/new')
    // Click the first state node
    await page.locator('.vue-flow__node').first().click()
    await expect(page.getByText('State Properties')).toBeVisible()
  })

  test('tools compendium opens', async ({ page }) => {
    await page.goto('/workflows/new')
    await page.getByRole('button', { name: 'Tools' }).click()
    await expect(page.getByRole('heading', { name: 'Tool Compendium' })).toBeVisible()
    // Should show client tabs
    await expect(page.getByRole('button', { name: 'Claude Code' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Codex' })).toBeVisible()
  })

  test('save new workflow creates record and updates URL', async ({ page }) => {
    await page.goto('/workflows/new')
    await page.locator('input[placeholder="Workflow name"]').fill('e2e-save-test')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saved')).toBeVisible()
    // URL should now have the record ID
    await expect(page).toHaveURL(/\/workflows\/[a-z0-9]+/)
    expect(page.url()).not.toContain('/new')
  })

  test('load existing workflow shows correct name', async ({ request, page }) => {
    const resp = await request.post(`${PB_URL}/api/collections/workflows/records`, {
      data: {
        name: 'e2e-load-test',
        definition: { id: 'e2e-load-test', initial: 'start', states: { start: { allowed_tools: ['Read'], on: { DONE: 'end' } }, end: { type: 'final' } } },
        active: false,
      },
    })
    const record = await resp.json()

    await page.goto(`/workflows/${record.id}`)
    await expect(page.locator('input[placeholder="Workflow name"]')).toHaveValue('e2e-load-test')
    // "start" appears as both the node label and the "start" badge — target the label
    await expect(page.locator('.state-node .font-bold', { hasText: 'start' })).toBeVisible()
  })

  test('delete workflow navigates back to list', async ({ request, page }) => {
    const resp = await request.post(`${PB_URL}/api/collections/workflows/records`, {
      data: {
        name: 'e2e-delete-editor-test',
        definition: { id: 'test', initial: 'a', states: { a: { type: 'final' } } },
        active: false,
      },
    })
    const record = await resp.json()

    await page.goto(`/workflows/${record.id}`)
    page.on('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Delete' }).click()
    await expect(page).toHaveURL('/workflows')
  })

  test('client selector switches tool palette', async ({ page }) => {
    await page.goto('/workflows/new')
    await page.locator('.vue-flow__node').first().click()
    await expect(page.getByText('Allowed Tools')).toBeVisible()

    // Switch to Codex
    await page.locator('select[title="Default tool palette"]').selectOption('Codex')
    await expect(page.getByRole('button', { name: 'shell' })).toBeVisible()
  })
})
