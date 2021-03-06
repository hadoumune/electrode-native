import {
  createTmpDir,
  NativeApplicationDescriptor,
  Platform,
  kax,
  log,
  gitCli,
  shell,
  fileUtils,
} from 'ern-core'
import { getContainerMetadataPath } from 'ern-container-gen'
import { getActiveCauldron } from 'ern-cauldron-api'
import { runCauldronContainerGen, runCaudronBundleGen } from './container'
import { runContainerTransformers } from './runContainerTransformers'
import { runContainerPublishers } from './runContainerPublishers'
import * as constants from './constants'
import path from 'path'
import semver from 'semver'
import _ from 'lodash'

//
// Perform some custom work on a container in Cauldron, provided as a
// function, that is going to change the state of the container,
// and regenerate a new container and publish it.
// If any part of this function fails, the Cauldron will not get updated
export async function performContainerStateUpdateInCauldron(
  stateUpdateFunc: () => Promise<any>,
  napDescriptor: NativeApplicationDescriptor,
  commitMessage: string | string[],
  {
    containerVersion,
    forceFullGeneration,
  }: {
    containerVersion?: string
    forceFullGeneration?: boolean
  } = {}
) {
  if (!napDescriptor.platform) {
    throw new Error(`${napDescriptor} does not specify a platform`)
  }

  const platform = napDescriptor.platform
  const outDir = Platform.getContainerGenOutDirectory(platform)
  let cauldronContainerNewVersion
  let cauldron

  try {
    cauldron = await getActiveCauldron()

    const currentContainerVersion = await cauldron.getContainerVersion(
      napDescriptor
    )

    if (containerVersion) {
      cauldronContainerNewVersion = containerVersion
    } else {
      cauldronContainerNewVersion = await cauldron.getTopLevelContainerVersion(
        napDescriptor
      )
      if (cauldronContainerNewVersion) {
        cauldronContainerNewVersion = semver.inc(
          cauldronContainerNewVersion,
          'patch'
        )
      } else {
        // Default to 1.0.0 for Container version
        cauldronContainerNewVersion = '1.0.0'
      }
    }

    // Begin a Cauldron transaction
    await cauldron.beginTransaction()

    // Retrieve the list of native dependencies currently in Container
    // (before state of the Container is modified)
    const nativeDependenciesBefore = await cauldron.getNativeDependencies(
      napDescriptor
    )

    // Perform the custom container state update
    await stateUpdateFunc()

    // Retrieve the list of native dependencies after the state of the Container
    // has been modified.
    const nativeDependenciesAfter = await cauldron.getNativeDependencies(
      napDescriptor
    )

    // Is there any changes to native dependencies in the Container ?
    const sameNativeDependencies =
      _.xorBy(nativeDependenciesBefore, nativeDependenciesAfter, 'fullPath')
        .length === 0

    const containerGenConfig = await cauldron.getContainerGeneratorConfig(
      napDescriptor
    )
    const publishers =
      (containerGenConfig && containerGenConfig.publishers) || []
    const gitPublisher = publishers.find(p => p.name.startsWith('git'))

    // No need to regenerate a full Container if there were no changes to
    // native dependencies in the Container; unless the forceFullGeneration
    // flag is set or if there are no git publishers
    let jsBundleOnly =
      sameNativeDependencies && !forceFullGeneration && gitPublisher

    const compositeMiniAppDir = createTmpDir()

    // Only regenerate bundle if possible
    if (jsBundleOnly) {
      try {
        log.info(
          `No native dependencies changes from ${currentContainerVersion}`
        )
        log.info('Regenerating JS bundle only')
        // Clean outDir
        shell.rm('-rf', path.join(outDir, '{.*,*}'))
        // git clone to outDir
        await gitCli().clone(gitPublisher.url, outDir)
        // git checkout current container version tag
        await gitCli(outDir).checkout(`v${currentContainerVersion}`)
        // and recreate bundle
        await runCaudronBundleGen(napDescriptor, {
          compositeMiniAppDir,
          outDir,
        })

        // Remove .git dir
        shell.rm('-rf', path.join(outDir, '.git'))
        // Update container metadata
        const metadata = await fileUtils.readJSON(
          getContainerMetadataPath(outDir)
        )
        const miniapps = await cauldron.getContainerMiniApps(napDescriptor)
        const jsApiImpls = await cauldron.getContainerJsApiImpls(napDescriptor)
        metadata.miniApps = miniapps.map(m => m.fullPath)
        metadata.jsApiImpls = jsApiImpls.map(j => j.fullPath)
        metadata.ernVersion = Platform.currentVersion
        await fileUtils.writeJSON(getContainerMetadataPath(outDir), metadata)
      } catch (e) {
        log.error(`Something went wrong trying to regenerate JS bundle only`)
        log.error(e)
        log.error(`Falling back to full Container generation`)
        jsBundleOnly = false
      }
    }

    if (!jsBundleOnly) {
      // Otherwise full container
      await runCauldronContainerGen(napDescriptor, {
        compositeMiniAppDir,
        outDir,
      })
    }

    // Update container version in Cauldron
    await cauldron.updateContainerVersion(
      napDescriptor,
      cauldronContainerNewVersion
    )

    // Update version of ern used to generate this Container
    await cauldron.updateContainerErnVersion(
      napDescriptor,
      Platform.currentVersion
    )

    // Update yarn lock
    const pathToNewYarnLock = path.join(compositeMiniAppDir, 'yarn.lock')
    await cauldron.addOrUpdateYarnLock(
      napDescriptor,
      constants.CONTAINER_YARN_KEY,
      pathToNewYarnLock
    )

    // Run Container transformers sequentially (if any)
    // Only run them if a full container was regenerated and not only js bundle
    // otherwise it will apply transformers on top of a project already transformed
    if (!jsBundleOnly) {
      await runContainerTransformers({ napDescriptor, containerPath: outDir })
    }

    // Commit Cauldron transaction
    await kax
      .task('Updating Cauldron')
      .run(cauldron.commitTransaction(commitMessage))

    log.info(
      `Added new container version ${cauldronContainerNewVersion} for ${napDescriptor} in Cauldron`
    )
  } catch (e) {
    log.error(`[performContainerStateUpdateInCauldron] An error occurred: ${e}`)
    if (cauldron) {
      cauldron.discardTransaction()
    }
    throw e
  }

  return runContainerPublishers({
    containerPath: outDir,
    containerVersion: cauldronContainerNewVersion,
    napDescriptor,
  })
}
