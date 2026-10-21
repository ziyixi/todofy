import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, type FormEvent } from 'react'
import { ApiError, todofy } from '../api/client'
import { keys } from '../api/queries'
import { idOf, mailEventName, reconcileActions, ReconcileAction, type MailEvent, type ReconcileActionName } from '../api/types'
import { useRequestId } from '../api/useAction'
import { Modal } from '../components/Modal'
import { Button, ErrorPanel } from '../components/ui'
import { shortId } from '../lib/format'
import { RECONCILE_ACTIONS } from '../lib/labels'

interface Props {
  event: MailEvent
  action: ReconcileActionName
  onClose: () => void
  onDone: (event: MailEvent) => void
}

export function ReconcileDialog({ event, action, onClose, onDone }: Props) {
  const copy = RECONCILE_ACTIONS[action]
  const formId = useId()
  const { idFor } = useRequestId()
  const client = useQueryClient()
  const eventId = idOf(event.name)
  const short = shortId(eventId)

  const mutation = useMutation({
    mutationFn: (request: { etag: string; taskId: string; requestId: string }) =>
      todofy.reconcileMailEvent({
        name: mailEventName(eventId),
        action: reconcileActions.value(action) ?? ReconcileAction.UNSPECIFIED,
        ...request,
      }),
    onSuccess: (detail) => {
      client.setQueryData(keys.event(eventId), detail)
      void client.invalidateQueries({ queryKey: keys.events })
      void client.invalidateQueries({ queryKey: keys.overview })
      onDone(detail)
    },
    onError: (error) => {
      // A stale etag or an action no longer allowed carries the event as it is now: the page shows it at once.
      if (error instanceof ApiError && error.event) client.setQueryData(keys.event(eventId), error.event)
    },
  })

  function submit(form: FormEvent) {
    form.preventDefault()
    if (mutation.isPending) return
    // Retry and dismiss take no task ID: the task actions are no longer offered (Todofy writes no task).
    const request = { etag: event.etag, taskId: '' }
    mutation.mutate({ ...request, requestId: idFor({ action, ...request }) })
  }

  function reloadEvent() {
    void client.invalidateQueries({ queryKey: keys.event(eventId) })
    onClose()
  }

  const stale = mutation.error instanceof ApiError && ['ETAG_MISMATCH', 'ACTION_NOT_ALLOWED'].includes(mutation.error.reason)

  return (
    <Modal
      title={copy.title}
      onClose={onClose}
      busy={mutation.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            取消
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={copy.destructive ? 'danger' : 'primary'}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? '正在提交…' : copy.confirm}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="stack">
        <p className={copy.destructive ? 'consequence consequence-danger' : 'consequence'}>{copy.consequence}</p>
        <p className="muted">
          事件 <code>{short}</code> · 版本 {event.version}
        </p>
      </form>
      {mutation.isError ? (
        <div className="stack">
          <ErrorPanel error={mutation.error} />
          {stale ? <Button onClick={reloadEvent}>刷新事件</Button> : null}
        </div>
      ) : null}
    </Modal>
  )
}
