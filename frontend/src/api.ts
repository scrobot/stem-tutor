import type {
  AiCheck,
  AiModel,
  AiStatus,
  Grid,
  Health,
  Lesson,
  LessonPrefs,
  LessonSummary,
  ProducerAnswer,
  ProducerRequest,
  Role,
  Settings,
} from './types'

/**
 * What this UI needs from the server (GET /api/health → `api`). Raise it together with
 * server.py's API_LEVEL when the UI starts using new routes: an older server then gets a banner
 * asking to restart it.
 */
export const API_LEVEL = 2

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
  // The AI producer (OpenRouter). The key is sent once and only its hint comes back.
  ai: () => request<AiStatus>('/api/ai'),
  saveAi: (p: { key?: string | null; model?: string | null }) => request<AiStatus>('/api/ai', json('PUT', p)),
  checkAi: () => request<AiCheck>('/api/ai/check'),
  aiModels: () => request<{ models: AiModel[] }>('/api/ai/models'),
  producer: (id: string) => request<ProducerAnswer>(`/api/lessons/${id}/cover/producer`),
  askProducer: (id: string, body: ProducerRequest) => request<ProducerAnswer>(`/api/lessons/${id}/cover/producer`, json('POST', body)),
  clearProducer: (id: string) => request<void>(`/api/lessons/${id}/cover/producer`, { method: 'DELETE' }),
  // A good pass in the trainer, merged into prefs.coverLearned by the server (safe across tabs).
  addLearnedMark: (
    id: string,
    mark: { part: string; layer: string; start: number; end: number; acc: number; tempo: number; at: number },
  ) => request<{ coverLearned: unknown[] }>(`/api/lessons/${id}/cover/learned`, json('POST', mark)),
}

export const mediaUrl = (lessonId: string, rel: string) =>
  `/api/lessons/${lessonId}/media/${rel.split('/').map(encodeURIComponent).join('/')}`

export const exportAudioUrl = (lessonId: string, kind: 'stem' | 'backing' | 'mix', part?: string) =>
  `/api/lessons/${lessonId}/export/audio?kind=${kind}${part ? `&part=${encodeURIComponent(part)}` : ''}`
