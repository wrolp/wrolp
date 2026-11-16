import { test, expect } from './helpers/fixtures'
import { resolveLsFsTarget } from '../../src/components/terminal/lsFsTarget'

// The terminal's file features (ls click-to-open, the `cd` directory dropdown,
// cwd verification, open-in-editor) must browse the INNER host when the shell is
// a container or a pod. A plain `local` target lists the Windows drives even
// though the prompt says `root in /` — the docker-local bug.

test('a local docker exec shell browses the container filesystem', () => {
  expect(
    resolveLsFsTarget({
      isLocal: true,
      isWsl: false,
      tabId: 7,
      distro: null,
      dockerContainer: 'debian-env',
      k8sExec: null,
    }),
  ).toEqual({ kind: 'dockerLocal', container: 'debian-env' })
})

test('a local kubectl exec shell browses the pod filesystem', () => {
  expect(
    resolveLsFsTarget({
      isLocal: true,
      isWsl: false,
      tabId: 7,
      distro: null,
      dockerContainer: null,
      k8sExec: { namespace: 'apps', pod: 'web-0', container: 'nginx' },
    }),
  ).toEqual({
    kind: 'k8sPod',
    host: { kind: 'local' },
    context: null,
    namespace: 'apps',
    pod: 'web-0',
    container: 'nginx',
  })
})

test('a WSL tab still browses the distribution', () => {
  expect(
    resolveLsFsTarget({
      isLocal: true,
      isWsl: true,
      tabId: 7,
      distro: 'Ubuntu-22.04',
      dockerContainer: null,
      k8sExec: null,
    }),
  ).toEqual({ kind: 'wsl', tabId: 7, distro: 'Ubuntu-22.04' })
})

test('a plain local shell still browses the local machine', () => {
  expect(
    resolveLsFsTarget({
      isLocal: true,
      isWsl: false,
      tabId: 7,
      distro: null,
      dockerContainer: null,
      k8sExec: null,
    }),
  ).toEqual({ kind: 'local', tabId: 7 })
})

test('a docker exec inside an SSH session goes through the host docker CLI', () => {
  expect(
    resolveLsFsTarget({
      isLocal: false,
      isWsl: false,
      tabId: 7,
      distro: null,
      dockerContainer: 'web',
      k8sExec: null,
    }),
  ).toEqual({ kind: 'docker', jumpTabId: 7, container: 'web' })
})

test('a kubectl exec inside an SSH session goes through the host kubectl', () => {
  expect(
    resolveLsFsTarget({
      isLocal: false,
      isWsl: false,
      tabId: 7,
      distro: null,
      dockerContainer: null,
      k8sExec: { context: 'prod', namespace: 'apps', pod: 'web-0' },
    }),
  ).toEqual({
    kind: 'k8sPod',
    host: { kind: 'ssh', jumpTabId: 7 },
    context: 'prod',
    namespace: 'apps',
    pod: 'web-0',
    container: null,
  })
})

test('a plain SSH session still uses its SFTP', () => {
  expect(
    resolveLsFsTarget({
      isLocal: false,
      isWsl: false,
      tabId: 7,
      distro: null,
      dockerContainer: null,
      k8sExec: null,
    }),
  ).toEqual({ kind: 'session', tabId: 7 })
})
