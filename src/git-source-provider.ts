import * as core from '@actions/core'
import * as fsHelper from './fs-helper'
import * as gitAuthHelper from './git-auth-helper'
import * as gitCommandManager from './git-command-manager'
import * as gitDirectoryHelper from './git-directory-helper'
import * as githubApiHelper from './github-api-helper'
import * as io from '@actions/io'
import * as path from 'path'
import * as refHelper from './ref-helper'
import * as stateHelper from './state-helper'
import * as urlHelper from './url-helper'
import {IGitCommandManager} from './git-command-manager'
import {IGitSourceSettings} from './git-source-settings'

export async function getSource(settings: IGitSourceSettings): Promise<void> {
  // Repository URL
  core.info(
    `Syncing repository: ${settings.repositoryOwner}/${settings.repositoryName}`
  )
  const repositoryUrl = urlHelper.getFetchUrl(settings)

  // Remove conflicting file path
  if (fsHelper.fileExistsSync(settings.repositoryPath)) {
    await io.rmRF(settings.repositoryPath)
  }

  // Create directory
  let isExisting = true
  if (!fsHelper.directoryExistsSync(settings.repositoryPath)) {
    isExisting = false
    await io.mkdirP(settings.repositoryPath)
  }

  // Git command manager
  core.startGroup('Getting Git version info')
  const git = await getGitCommandManager(settings.repositoryPath, settings.lfs)
  core.endGroup()

  // Prepare existing directory, otherwise recreate
  if (isExisting) {
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      settings.repositoryPath,
      repositoryUrl,
      settings.clean,
      settings.ref
    )
  }

  if (!git) {
    // Downloading using REST API
    core.info(`The repository will be downloaded using the GitHub REST API`)
    core.info(
      `To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH`
    )
    if (settings.submodules) {
      throw new Error(
        `Input 'submodules' not supported when falling back to download using the GitHub REST API. To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH.`
      )
    } else if (settings.sshKey) {
      throw new Error(
        `Input 'ssh-key' not supported when falling back to download using the GitHub REST API. To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH.`
      )
    }

    await githubApiHelper.downloadRepository(
      settings.authToken,
      settings.repositoryOwner,
      settings.repositoryName,
      settings.ref,
      settings.commit,
      settings.repositoryPath
    )
    return
  }

  // Save state for POST action
  stateHelper.setRepositoryPath(settings.repositoryPath)

  // Initialize the repository
  if (
    !fsHelper.directoryExistsSync(path.join(settings.repositoryPath, '.git'))
  ) {
    core.startGroup('Initializing the repository')
    await git.init()
    await git.remoteAdd('origin', repositoryUrl)
    core.endGroup()
  }

  // Disable automatic garbage collection
  core.startGroup('Disabling automatic garbage collection')
  if (!(await git.tryDisableAutomaticGarbageCollection())) {
    core.warning(
      `Unable to turn off git automatic garbage collection. The git fetch operation may trigger garbage collection and cause a delay.`
    )
  }
  core.endGroup()

  const authHelper = gitAuthHelper.createAuthHelper(git, settings)
  try {
    // Configure auth
    core.startGroup('Setting up auth')
    await authHelper.configureAuth()
    core.endGroup()

    // Determine the default branch
    if ((!settings.ref && !settings.commit) || (settings.ref && !(await git.remoteBranchExists(settings.ref)))) {
      core.startGroup('Determining the default branch')
      if (settings.sshKey) {
        settings.ref = await git.getDefaultBranch(repositoryUrl)
      } else {
        settings.ref = await githubApiHelper.getDefaultBranch(
          settings.authToken,
          settings.repositoryOwner,
          settings.repositoryName
        )
      }
      core.endGroup()
    }

    // LFS install
    if (settings.lfs) {
      await git.lfsInstall()
    }

    // Fetch
    core.startGroup('Fetching the repository')
    if (settings.fetchDepth <= 0) {
      // Fetch all branches and tags
      let refSpec = refHelper.getRefSpecForAllHistory(
        settings.ref,
        settings.commit
      )
      await git.fetch(refSpec)

      // When all history is fetched, the ref we're interested in may have moved to a different
      // commit (push or force push). If so, fetch again with a targeted refspec.
      if (!(await refHelper.testRef(git, settings.ref, settings.commit))) {
        refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
        await git.fetch(refSpec)
      }
    } else {
      const refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
      await git.fetch(refSpec, settings.fetchDepth)
    }
    core.endGroup()

    // Checkout info
    core.startGroup('Determining the checkout info')
    const checkoutInfo = await refHelper.getCheckoutInfo(
      git,
      settings.ref,
      settings.commit
    )
    core.endGroup()

    // LFS fetch
    // Explicit lfs-fetch to avoid slow checkout (fetches one lfs object at a time).
    // Explicit lfs fetch will fetch lfs objects in parallel.
    if (settings.lfs) {
      core.startGroup('Fetching LFS objects')
      await git.lfsFetch(checkoutInfo.startPoint || checkoutInfo.ref)
      core.endGroup()
    }

    // Checkout
    core.startGroup('Checking out the ref')
    await git.checkout(checkoutInfo.ref, checkoutInfo.startPoint)
    core.endGroup()

    // Submodules
    if (settings.submodules) {
      try {
        // Temporarily override global config
        core.startGroup('Setting up auth for fetching submodules')
        await authHelper.configureGlobalAuth()
        core.endGroup()

        // Checkout submodules
        core.startGroup('Fetching submodules')
        await git.submoduleSync(settings.nestedSubmodules)
        await git.submoduleUpdate(
          settings.fetchDepth,
          settings.nestedSubmodules
        )
        await git.submoduleForeach(
          'git config --local gc.auto 0',
          settings.nestedSubmodules
        )
        core.endGroup()

        // Persist credentials
        if (settings.persistCredentials || settings.submodulesRemoteBranch) {
          core.startGroup('Persisting credentials for submodules')
          await authHelper.configureSubmoduleAuth()
          core.endGroup()
        }

        // Checkout submodules remote branch
        if (settings.submodulesRemoteBranch) {
	        core.startGroup('Checkout submodules remote branch ' + settings.submodulesRemoteBranch)
          // Get submodules list
          const submodulesList = await git.getSubmodulesList()
          for (let sub of submodulesList) {
            // for each submodule, fetch the appropriate information
            const subGit = await getGitCommandManager(settings.repositoryPath + '/' + sub, settings.lfs)
            if (!subGit) {
              core.debug('subGit is NULL')
            }
            if (subGit && await subGit.remoteBranchExists(settings.submodulesRemoteBranch)) {
              // LFS install
              if (settings.lfs) {
                await subGit.lfsInstall()
              }

              // Here the submodule synchronization has already fetched everything in case fetchDepth
              // is < = 0, so only fetch the ref if fetchDepth is superior.
              if (settings.fetchDepth > 0) {
                  const refSpec = refHelper.getRefSpec(settings.submodulesRemoteBranch, '')
                  await subGit.fetch(refSpec, settings.fetchDepth)
              }

              const subCheckoutInfo = await refHelper.getCheckoutInfo(
                subGit,
                settings.submodulesRemoteBranch,
                ''
              )

              if (settings.lfs) {
                await subGit.lfsFetch(subCheckoutInfo.startPoint || subCheckoutInfo.ref)
              }

              await subGit.checkout(subCheckoutInfo.ref, subCheckoutInfo.startPoint)
            }
          }
          core.endGroup()
	      }
      } finally {
        // Remove temporary global config override
        await authHelper.removeGlobalAuth()
      }
    }

    // Get commit information
    const commitInfo = await git.log1()

    // Log commit sha
    await git.log1("--format='%H'")

    // Check for incorrect pull request merge commit
    await refHelper.checkCommitInfo(
      settings.authToken,
      commitInfo,
      settings.repositoryOwner,
      settings.repositoryName,
      settings.ref,
      settings.commit
    )
  } finally {
    // Remove auth
    if (!settings.persistCredentials) {
      core.startGroup('Removing auth')
      await authHelper.removeAuth()
      core.endGroup()
    }
  }
}

export async function cleanup(repositoryPath: string): Promise<void> {
  // Repo exists?
  if (
    !repositoryPath ||
    !fsHelper.fileExistsSync(path.join(repositoryPath, '.git', 'config'))
  ) {
    return
  }

  let git: IGitCommandManager
  try {
    git = await gitCommandManager.createCommandManager(repositoryPath, false)
  } catch {
    return
  }

  // Remove auth
  const authHelper = gitAuthHelper.createAuthHelper(git)
  await authHelper.removeAuth()
}

async function getGitCommandManager(
  repositoryPath: string, lfs: boolean
): Promise<IGitCommandManager | undefined> {
  core.info(`Working directory is '${repositoryPath}'`)
  try {
    return await gitCommandManager.createCommandManager(
      repositoryPath,
      lfs
    )
  } catch (err) {
    // Git is required for LFS
    if (lfs) {
      throw err
    }

    // Otherwise fallback to REST API
    return undefined
  }
}
