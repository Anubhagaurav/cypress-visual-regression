import * as fs from 'fs'
import { existsSync } from 'fs'
import * as path from 'path'
import pixelMatch from 'pixelmatch'
import { PNG } from 'pngjs'
import sanitize from 'sanitize-filename'
import { adjustCanvas } from './utils/image'
import { logger } from './utils/logger'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export type PluginSetupOptions = {
  errorThreshold: number
  failSilently: boolean
}
export type PluginCommandOptions = number | ScreenshotOptions
export type ScreenshotOptions = Partial<Cypress.ScreenshotOptions & PluginSetupOptions>
export type DiffOption = 'always' | 'fail' | 'never'
export type TypeOption = 'regression' | 'base'

export type VisualRegressionOptions = {
  /** kind of comparison that we are going to execute */
  type: TypeOption
  /** new image name */
  screenshotName: string
  /** threshold value from 0 to 1. 0.01 will be 1%  */
  errorThreshold: number
  /** subdirectory to be added to base directory */
  specName: string
  /** absolute path and name of the original image **_including file termination_** */
  screenshotAbsolutePath: string
  screenshotOptions: ScreenshotOptions
  /** base directory where to move the image, if omitted default will be **'cypress/snapshots/base'** */
  baseDirectory?: string
  /** diff directory were we store the diff images, if omitted default will be  **'cypress/snapshots/diff'** */
  diffDirectory?: string
  /** how we should handle diff images */
  generateDiff?: DiffOption
  /** if set to true failing test will not be thrown */
  failSilently: boolean
  /** Cypress spec file object info */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: any // TODO change to Cypress.Spec after https://github.com/cypress-io/cypress/issues/29048 is fixed
}

export type UpdateSnapshotOptions = Pick<
  VisualRegressionOptions,
  'screenshotName' | 'specName' | 'screenshotAbsolutePath' | 'baseDirectory' | 'spec'
>

export type CompareSnapshotOptions = Omit<VisualRegressionOptions, 'failSilently' | 'type'>

export type VisualRegressionResult = {
  error?: string
  images: {
    actual?: string // base64
    base?: string // base64
    diff?: string // base64
  }
  baseGenerated?: boolean
  mismatchedPixels?: number
  percentage?: number
}

/**
 * Update the base snapshot .png by copying the generated snapshot to the base snapshot directory.
 * The target path is constructed from parts at runtime in node to be OS independent.
 * */
export const updateSnapshot = async (options: UpdateSnapshotOptions): Promise<VisualRegressionResult> => {
  const toDir = options.baseDirectory ?? path.join(process.cwd(), 'cypress', 'snapshots', 'base')
  const destDir = path.join(toDir, options.spec.relative)
  const sanitizedFileName: string = sanitize(options.screenshotName)
  const destFile = path.join(destDir, `${sanitizedFileName}.png`)
  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(options.screenshotAbsolutePath, destFile)
  const fileBuffer = fs.readFileSync(destFile)
  logger.info(`Updated base snapshot '${options.screenshotName}' at ${destFile}`)
  logger.debug('UpdateSnapshotOptions: ', JSON.stringify(options, undefined, 2))
  moveActualSnapshotIfNeeded(options.screenshotAbsolutePath, options.spec.relativeToCommonRoot)
  return { images: { actual: fileBuffer.toString('base64') }, baseGenerated: true }
}

/**
 * @description  For some reason Cypress does save the screenshots in the wrong folder when running in headless mode
 * It will use spec file to build an extra folder in the path
 * This is a workaround to remove the extra folder from the path
 * ie:
 * [CORRECT]   cypress open => .../snapshots/actual/cypress/e2e/alt-sub/foo/deep.cy.ts/inside_context.png
 * [INCORRECT] cypress run =>  .../snapshots/actual/deep.cy.ts/cypress/e2e/alt-sub/foo/deep.cy.ts/inside_context.png
 *
 * looking at Cypress.Spec we can see that the relativeToCommonRoot is set only when running in headless mode
 * and that is the only time we need to remove the extra folder from the path
 *
 * ref: https://github.com/cypress-io/cypress/issues/29057
 *
 * @param actualScreenshot
 * @param relativeToCommonRoot
 * @returns boolean
 */
const moveActualSnapshotIfNeeded = (actualScreenshot: string, relativeToCommonRoot?: string): boolean => {
  if (relativeToCommonRoot != null) {
    const newPath = actualScreenshot.replace(relativeToCommonRoot + '/', '')
    const newDirectory = path.dirname(newPath)
    if (!fs.existsSync(newDirectory)) {
      fs.mkdirSync(newDirectory, { recursive: true })
    }
    fs.renameSync(actualScreenshot, newPath)
    pruneEmptyDirectoriesInverse(path.dirname(actualScreenshot))
  }
  return true
}

// Function to recursively prune empty directories in the inverse order
const pruneEmptyDirectoriesInverse = (directory: string): void => {
  // check if the current directory is empty and remove it if it is
  if (fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory)
    logger.debug(`Removed empty directory: ${directory}`)
    // recursively prune the parent directory
    pruneEmptyDirectoriesInverse(path.dirname(directory))
  }
}

/**
 * Cypress plugin to compare image snapshots & generate a diff image.
 * Uses the pixelmatch library internally.
 * */
export const compareSnapshots = async (options: CompareSnapshotOptions): Promise<VisualRegressionResult> => {
  options.baseDirectory = options.baseDirectory ?? path.join(process.cwd(), 'cypress', 'snapshots', 'base')
  options.diffDirectory = options.diffDirectory ?? path.join(process.cwd(), 'cypress', 'snapshots', 'diff')
  options.generateDiff = options.generateDiff ?? 'fail'
  const sanitizedFileName: string = sanitize(options.screenshotName)

  const expectedImagePath = path.join(options.baseDirectory, options.spec.relative, `${sanitizedFileName}.png`)
  if (!existsSync(expectedImagePath)) {
    return { error: `Base screenshot not found at ${expectedImagePath}`, images: {} }
  }
  const expectedImageBuffer = readFileSync(expectedImagePath)
  const expectedImage = PNG.sync.read(expectedImageBuffer)

  const actualImagePath = options.screenshotAbsolutePath
  const actualImageBuffer = readFileSync(actualImagePath)
  const actualImage = PNG.sync.read(actualImageBuffer)

  const diffImagePath = path.join(options.diffDirectory, options.spec.relative, `${sanitizedFileName}.png`)
  const diffImage = new PNG({
    width: Math.max(actualImage.width, expectedImage.width),
    height: Math.max(actualImage.height, expectedImage.height)
  })

  const imgActualFullCanvas = adjustCanvas(actualImage, diffImage.width, diffImage.height)
  const imgExpectedFullCanvas = adjustCanvas(expectedImage, diffImage.width, diffImage.height)

  const mismatchedPixels = pixelMatch(
    imgActualFullCanvas.data,
    imgExpectedFullCanvas.data,
    diffImage.data,
    diffImage.width,
    diffImage.height,
    { threshold: 0.1 }
  )
  const percentage = (mismatchedPixels / diffImage.width / diffImage.height) ** 0.5
  const regressionError = percentage > options.errorThreshold
  const result: VisualRegressionResult = {
    images: {
      actual: actualImageBuffer.toString('base64'),
      base: expectedImageBuffer.toString('base64')
    },
    mismatchedPixels,
    percentage
  }

  if (options.generateDiff === 'always' || (regressionError && options.generateDiff === 'fail')) {
    mkdirSync(path.dirname(diffImagePath), { recursive: true })
    const diffImageBuffer = PNG.sync.write(diffImage)
    writeFileSync(diffImagePath, diffImageBuffer)
    result.images.diff = diffImageBuffer.toString('base64')
  }

  if (regressionError) {
    logger.error(`Error in visual regression found: ${percentage.toFixed(2)}`)

    result.error = `The '${options.screenshotName}' image is different. Threshold limit of '${
      options.errorThreshold
    }' exceeded: '${percentage.toFixed(2)}'`
  }
  return result
}

/** Configure the plugin to compare snapshots. */
export const configureVisualRegression = (on: Cypress.PluginEvents): void => {
  on('task', {
    compareSnapshots,
    updateSnapshot
  })
}
