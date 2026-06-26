export type DeleteUndoToastProps = {
  message: string
  onUndo: () => void
  onDismiss: () => void
}

export function DeleteUndoToast({
  message,
  onUndo,
  onDismiss,
}: DeleteUndoToastProps) {
  return (
    <div
      className="delete-undo-toast"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="delete-undo-toast__msg">{message}</span>
      <button
        type="button"
        className="btn btn-primary delete-undo-toast__undo"
        title="When focus is not in a text field, ⌘Z or Ctrl+Z also undoes."
        onClick={onUndo}
      >
        Undo
      </button>
      <button
        type="button"
        className="icon-btn delete-undo-toast__dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}
