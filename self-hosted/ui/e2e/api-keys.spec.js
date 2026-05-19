import { test, expect } from '@playwright/test'

const PB_URL = process.env.PB_URL || 'http://localhost:8090'

test.describe('API Keys', () => {
  // Clean state: remove all keys before and after each test
  test.beforeEach(async ({ request }) => {
    try {
      const resp = await request.fetch(`${PB_URL}/api/collections/api_keys/records`)
      if (!resp.ok()) return
      const data = await resp.json()
      for (const key of data.items || []) {
        await request.delete(`${PB_URL}/api/collections/api_keys/records/${key.id}`)
      }
    } catch {}
  })

  test.afterEach(async ({ request }) => {
    try {
      const resp = await request.fetch(`${PB_URL}/api/collections/api_keys/records`)
      if (!resp.ok()) return
      const data = await resp.json()
      for (const key of data.items || []) {
        await request.delete(`${PB_URL}/api/collections/api_keys/records/${key.id}`)
      }
    } catch {}
  })

  test('keys page loads with heading', async ({ page }) => {
    await page.goto('/keys')
    await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible()
    await expect(page.getByText('Keys for the MCP gateway')).toBeVisible()
  })

  test('shows empty state when no keys exist', async ({ page }) => {
    await page.goto('/keys')
    await expect(page.getByText('No API keys yet')).toBeVisible()
    await expect(page.getByText('Generate a key to connect agents')).toBeVisible()
  })

  test('generate key shows raw key with sw_ prefix', async ({ page }) => {
    await page.goto('/keys')
    await page.getByRole('button', { name: 'Generate Key' }).click()

    // Raw key banner appears
    await expect(page.getByText("won't be shown again")).toBeVisible()
    const keyDisplay = page.locator('code').first()
    await expect(keyDisplay).toBeVisible()
    const rawKey = await keyDisplay.textContent()
    expect(rawKey).toMatch(/^sw_/)
  })

  test('copy button works', async ({ page, context }) => {
    // Grant clipboard permission
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/keys')
    await page.getByRole('button', { name: 'Generate Key' }).click()
    await expect(page.getByText("won't be shown again")).toBeVisible()

    await page.getByRole('button', { name: 'Copy' }).click()
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  })

  test('generated key appears in list with prefix', async ({ page }) => {
    await page.goto('/keys')
    await page.getByRole('button', { name: 'Generate Key' }).click()

    const keyDisplay = page.locator('code').first()
    const rawKey = await keyDisplay.textContent()
    const prefix = rawKey.substring(0, 7)

    // Key should appear in the list below
    await expect(page.getByText(prefix + '...')).toBeVisible()
  })

  test('revoke key removes it from list', async ({ page }) => {
    await page.goto('/keys')

    // Generate a key
    await page.getByRole('button', { name: 'Generate Key' }).click()
    await expect(page.getByText("won't be shown again")).toBeVisible()

    // Key should be in the list
    const keyRow = page.locator('div.rounded-lg.bg-gray-50')
    await expect(keyRow).toHaveCount(1)

    // Revoke it
    await page.getByRole('button', { name: 'Revoke' }).first().click()

    // Key should be removed from the list
    await expect(keyRow).toHaveCount(0)
  })

  test('API key CRUD via PocketBase API', async ({ request }) => {
    // Create a key directly via PocketBase
    const createResp = await request.post(`${PB_URL}/api/collections/api_keys/records`, {
      data: {
        key_hash: 'sw_e2etestkey1234567890abcdef',
        prefix: 'sw_e2et',
        name: 'e2e-api-test',
      },
    })
    expect(createResp.ok()).toBeTruthy()
    const created = await createResp.json()
    expect(created.id).toBeTruthy()
    expect(created.prefix).toBe('sw_e2et')

    // List keys — verify it appears
    const listResp = await request.fetch(`${PB_URL}/api/collections/api_keys/records`)
    expect(listResp.ok()).toBeTruthy()
    const listData = await listResp.json()
    const found = listData.items.find(k => k.id === created.id)
    expect(found).toBeDefined()
    expect(found.name).toBe('e2e-api-test')

    // Delete the key
    const deleteResp = await request.delete(`${PB_URL}/api/collections/api_keys/records/${created.id}`)
    expect(deleteResp.ok()).toBeTruthy()

    // Verify gone
    const afterResp = await request.fetch(`${PB_URL}/api/collections/api_keys/records`)
    const afterData = await afterResp.json()
    expect(afterData.items.find(k => k.id === created.id)).toBeUndefined()
  })
})
