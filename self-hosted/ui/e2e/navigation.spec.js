import { test, expect } from '@playwright/test'

test.describe('Navigation', () => {
  test('home page loads with heading', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toContainText('Statewright')
  })

  test('navigation bar is visible with all links', async ({ page }) => {
    await page.goto('/')
    const nav = page.locator('nav').first()
    await expect(nav).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Workflows' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Runs' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'API Keys' })).toBeVisible()
  })

  test('can navigate to workflows from home', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Workflows' }).first().click()
    await expect(page).toHaveURL('/workflows')
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible()
  })

  test('can navigate to runs from home', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Runs' }).first().click()
    await expect(page).toHaveURL('/runs')
    await expect(page.getByRole('heading', { name: 'Run History' })).toBeVisible()
  })

  test('can navigate to API keys from home', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'API Keys' }).first().click()
    await expect(page).toHaveURL('/keys')
    await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible()
  })

  test('can navigate home via brand link', async ({ page }) => {
    await page.goto('/workflows')
    await page.locator('a[href="/"]').first().click()
    await expect(page).toHaveURL('/')
  })

  test('home page shows three section cards', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Create and edit state machine workflows')).toBeVisible()
    await expect(page.getByText('Monitor active workflow runs')).toBeVisible()
    await expect(page.getByText('Generate keys for the MCP gateway')).toBeVisible()
  })

  test('footer contains Statewright link', async ({ page }) => {
    await page.goto('/')
    const footer = page.locator('footer')
    await expect(footer.getByRole('link', { name: 'Statewright' })).toHaveAttribute('href', 'https://statewright.ai')
  })
})
