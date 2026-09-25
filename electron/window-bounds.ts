interface WorkArea { x: number; y: number; width: number; height: number }

/** Native window bounds include titlebar chrome and exclude the screen's Dock/menu bar. */
export function initialEditorWindowBounds(workArea: WorkArea) {
  const width = Math.min(1440, workArea.width)
  const height = Math.min(940, workArea.height)
  return {
    width, height,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    minWidth: Math.min(360, width),
    minHeight: Math.min(240, height),
  }
}
