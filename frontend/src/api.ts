import type { Grid, Health, Lesson, LessonPrefs, LessonSummary, Role, Settings } from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (typeof body.detail === 'string') message = body.detail
      else if (Array.isArray(body.detail)) message = body.detail.map((d: { msg?: string }) => d.msg).join('; ')
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  health: () => request<Health>('/api/health'),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (s: Settings) => request<Settings>('/api/settings', json('PUT', s)),
  lessons: () => request<LessonSummary[]>('/api/lessons'),
  lesson: (id: string) => request<Lesson>(`/api/lessons/${id}`),
  createLesson: (form: FormData) => request<Lesson>('/api/lessons', { method: 'POST', body: form }),
  patchLesson: (
    id: string,
    patch: {
      title?: string
      artist?: string
      grid?: Grid
      parts?: { id: string; name?: string; role?: Role }[]
      prefs?: LessonPrefs
    },
  ) => request<Lesson>(`/api/lessons/${id}`, json('PATCH', patch)),
  deleteLesson: (id: string) => request<void>(`/api/lessons/${id}`, { method: 'DELETE' }),
  retryLesson: (id: string) => request<Lesson>(`/api/lessons/${id}/retry`, { method: 'POST' }),
  cancelLesson: (id: string) => request<{ ok: boolean }>(`/api/lessons/${id}/cancel`, { method: 'POST' }),
}

export const mediaUrl = (lessonId: string, rel: string) =>
  `/api/lessons/${lessonId}/media/${rel.split('/').map(encodeURIComponent).join('/')}`

export const exportAudioUrl = (lessonId: string, kind: 'stem' | 'backing' | 'mix', part?: string) =>
  `/api/lessons/${lessonId}/export/audio?kind=${kind}${part ? `&part=${encodeURIComponent(part)}` : ''}`
