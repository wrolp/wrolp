import React, { useMemo } from 'react'
import {
  dockerContainerLogs,
  dockerLogsStreamStart,
  pollDockerLogs,
  stopDockerLogsStream,
} from '../commands'
import type { DockerHostRef } from '../types'
import { LogViewer, type LogSource } from './LogViewer'

interface DockerLogViewerProps {
  tabId: number
  /** Where the container lives: a connected jump-host tab, or this machine. */
  host: DockerHostRef
  containerName: string
  containerImage?: string
  initialTail?: number
  onAskAi?: (text: string) => void
  defaultWordWrap?: boolean
  defaultFollow?: boolean
  maxLines?: number
}

/** Docker's wiring of the shared log display: `docker logs` transport + header. */
export const DockerLogViewer: React.FC<DockerLogViewerProps> = ({
  host,
  containerName,
  containerImage,
  initialTail = 200,
  onAskAi,
  defaultWordWrap = true,
  defaultFollow = true,
  maxLines = 5000,
}) => {
  const source = useMemo<LogSource>(
    () => ({
      fetchTail: (tail) => dockerContainerLogs(host, containerName, tail),
      startStream: (tail) => dockerLogsStreamStart(host, containerName, tail),
      // Docker's drain reports chunks only: a `docker logs -f` that dies surfaces
      // as an error on the next poll, whereas kubectl's stream says `ended`.
      pollStream: async (streamId) => ({ chunks: await pollDockerLogs(streamId) }),
      stopStream: (streamId) => stopDockerLogsStream(streamId),
    }),
    [host, containerName],
  )
  return (
    <LogViewer
      title={containerName}
      subtitle={containerImage}
      source={source}
      initialTail={initialTail}
      onAskAi={onAskAi}
      aiSubject={`Docker container "${containerName}"`}
      defaultWordWrap={defaultWordWrap}
      defaultFollow={defaultFollow}
      maxLines={maxLines}
    />
  )
}
