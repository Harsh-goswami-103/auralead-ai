/**
 * T28 pipeline editor in the browser (PRD "React Flow pipeline ... rejects cycles/unsupported;
 * persisted"; 06-design F13), against the built DEMO app (T09 harness):
 *  - at 1440 px the React Flow canvas draws the five stages; connecting Draft back to Score with
 *    the keyboard panel shows the error on that connection (in the panel and on the canvas edge)
 *    and the loop in the validation summary; nothing is saved;
 *  - removing Score is valid, "Save as new version" answers "Saved v2, active", and after a reload
 *    v2 is the active version and v1 an earlier one;
 *  - at 390 px the pipeline is a read-only list with the "edit on a larger screen" note: no canvas,
 *    no editing controls, no horizontal page scroll.
 */
import { expect, test } from '@playwright/test';
import { resetAll, signIn } from '../support/panel-actions';

const WS = 'smile-avenue-dental';
const PIPELINE = `/dashboard/employee/${WS}/pipeline`;

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

test('a cycle shows the edge error; saving makes v2 active', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, 'Employee');
  await page.goto(PIPELINE);
  await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
  const editor = page.locator('[data-pipeline-editor]');
  await expect(editor.locator('[data-pipeline-canvas]')).toBeVisible();
  await expect(editor.locator('[data-stage-node]')).toHaveCount(5);
  await expect(editor.locator('.react-flow__attribution')).toBeVisible();

  await editor.getByLabel('From', { exact: true }).selectOption({ label: 'Draft' });
  await editor.getByLabel('To', { exact: true }).selectOption({ label: 'Score' });
  await editor.getByRole('button', { name: 'Add connection' }).click();
  const edge = editor.locator('[data-edge="draft->score"]');
  await expect(edge).toHaveAttribute('data-edge-error', 'true');
  await expect(edge).toContainText('Score cannot come after Draft');
  await expect(editor.locator('[data-validation="invalid"]')).toContainText('These connections form a loop.');
  await expect(editor.locator('.react-flow__edge-text', { hasText: 'Score cannot come after Draft' })).toBeVisible();

  await edge.getByRole('button', { name: 'Remove connection Draft to Score' }).click();
  await editor.getByLabel('Stage', { exact: true }).selectOption({ label: 'Score' });
  await editor.getByRole('button', { name: 'Remove Score' }).click();
  await expect(editor.locator('[data-validation="valid"]')).toBeVisible();
  await expect(editor.locator('[data-stage-node]')).toHaveCount(4);
  await editor.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.locator('[data-saved-version="2"]')).toContainText('Saved v2, active');

  await page.reload();
  await expect(page.locator('[data-version="2"][data-active="true"]')).toBeVisible();
  await expect(page.locator('[data-version="1"]')).toContainText('Earlier');
  await expect(page.locator('[data-pipeline-editor] [data-stage-node]')).toHaveCount(4);
});

test('at 390 px the pipeline is a read-only list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'Employee');
  await page.goto(PIPELINE);
  await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Pipeline stages in run order' });
  await expect(list).toBeVisible();
  await expect(list.locator('[data-stage-item]')).toHaveCount(5);
  await expect(page.getByText('the pipeline can be edited on a screen at least 768 px wide')).toBeVisible();
  await expect(page.locator('[data-pipeline-editor]')).toBeHidden();
  await expect(page.locator('[data-pipeline-canvas]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add connection' })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
