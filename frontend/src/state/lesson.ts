import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Lesson } from '../types'

export function useLesson(id: string | undefined) {
  const [lesson, setLesson] = useState<Lesson | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    if (!id) return
    api
      .lesson(id)
      .then((l) => {
        setLesson(l)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
  }, [id])
  useEffect(load, [load])
  const busy = lesson?.status === 'queued' || lesson?.status === 'processing'
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(load, 1000)
    return () => window.clearInterval(t)
  }, [busy, load])
  const patch = useCallback(
    async (p: Parameters<typeof api.patchLesson>[1]) => {
      if (!id) return
      const l = await api.patchLesson(id, p)
      setLesson(l)
    },
    [id],
  )
  return { lesson, error, reload: load, patch, setLesson }
}
