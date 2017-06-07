// @flow

import {
  Platform
} from '@walmart/ern-util'
import Api from './api'
import FileStore from './filestore'
import GitStore from './gitstore'

export default function factory (
  repository: string,
  branch: string = 'master',
  ernPath: string = Platform.rootDirectory) {
  const sourcemapStore = new FileStore(ernPath, repository, branch, 'sourcemaps')
  const binaryStore = new FileStore(ernPath, repository, branch, 'binaries')
  const dbStore = new GitStore(ernPath, repository, branch)
  return new Api(dbStore, binaryStore, sourcemapStore)
}
