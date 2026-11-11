// A minimal event emitter with VS Code's shape (`event(listener) → Disposable`),
// so the data layer runs, and is tested, without the vscode module.

export type Disposable = { dispose(): void }
export type Event<T> = (listener: (value: T) => void) => Disposable

export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(value: T) => void>()

  readonly event: Event<T> = listener => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value)
  }

  dispose(): void {
    this.listeners.clear()
  }
}
